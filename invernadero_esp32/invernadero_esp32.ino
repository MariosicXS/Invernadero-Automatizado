/*
  Sketch para control de Invernadero Inteligente Cloud (Firebase + PIR)
  - Control de Temperatura (Ventilación y Calefacción/Luz) con relés Active LOW
  - Control de Humedad de Suelo (Riego) con relé Active LOW
  - Detección de Movimiento por Sensor PIR (GPIO 13) conectado directamente al ESP32
  - Sincronización en Tiempo Real con Firebase Realtime Database
  - SISTEMA DE SUJETO MUERTO (Dead Man's Switch - 20 segundos)
  - SISTEMA DE SEGURIDAD GENERAL (Corte automático a los 7 minutos si se atasca)
  - BLOQUEO TÉRMICO CRÍTICO (> 28.5 °C) - Fuerza extractor ON, apaga calefactor y bloquea controles manuales
*/
#include <WiFi.h>
#include <FirebaseESP32.h>
#include <DHT.h>
// Proporciona funciones de ayuda para la autenticación y base de datos de Firebase
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>

// =========================================================================
// --- CONFIGURACIÓN DE RED Y CLOUD (Modifica estos datos con los tuyos) ---
// =========================================================================
#define WIFI_SSID "HH SH"
#define WIFI_PASSWORD "69711328@1234Hhh"
// URL de Firebase (Paso 3 de la guía de Firebase)
#define FIREBASE_HOST "https://invernadero-ebc2f-default-rtdb.firebaseio.com/"
// Token secreto de Firebase (Paso 4 de la guía de Firebase)
#define FIREBASE_AUTH "yMjJcaz3MsT0YLzM5jnKS2A72iP856QFjx1CEBfH"

// =========================================================================
// --- DEFINICIÓN DE PINES (Hardware real extraído de conexiones.docx) ---
// =========================================================================
#define PIN_DHT 4            // Sensor de temperatura DHT11
#define PIN_SUELO 34        // Sensor Capacitivo de Humedad (ADC1)
#define PIN_RELE_VENT 15    // Ventilador (Active LOW)
#define PIN_RELE_LUZ 2      // Calefacción / Luz (Active LOW)
#define PIN_RELE_RIEGO 5    // Bomba de Riego (Active LOW)
#define PIN_PIR 13          // Sensor PIR de movimiento (HIGH = Movimiento) conectado directo al ESP32

// --- CONFIGURACIÓN DE DHT ---
#define DHTTYPE DHT11        
DHT dht(PIN_DHT, DHTTYPE);

// --- CALIBRACIÓN SUELO ---
const int VALOR_SECO = 4095;
const int VALOR_MOJADO = 1800; 

// --- VARIABLES GLOBALES DEL SISTEMA ---
float temperatura = 0.0;
int humedadSuelo = 0;
bool modoAutomatico = true;     // true = AUTO, false = MANUAL
bool movimientoDetectado = false;
bool seguridadPIR = false;       // true = Enciende luces/calefacción física al detectar movimiento, false = sólo notifica
String mensajeSistema = "Iniciando sistema...";

// Variables de estado físicas de los relés (Active LOW: LOW = ON, HIGH = OFF)
#define RELE_ON LOW
#define RELE_OFF HIGH

// Variables de tiempo (Lectura de sensores cada 3s)
unsigned long ultimoTiempoLectura = 0;
const long intervaloLectura = 3000;

// Variables de control de tiempo del PIR para evitar alertas parpadeantes
unsigned long ultimoMovimientoTiempo = 0;
const unsigned long TIMEOUT_PIR = 10000; // Mantener alerta activa por 10s después de detectar movimiento

// Variables de Seguridad (Corte de 7 minutos para relés activos continuos)
unsigned long inicioVent = 0;
unsigned long inicioLuz = 0;
unsigned long inicioRiego = 0;
const unsigned long LIMITE_SEGURIDAD = 420000; // 7 minutos en milisegundos

// --- VARIABLES DE SUJETO MUERTO (DEAD MAN'S SWITCH - 20s) ---
bool deadManActivo = false;
unsigned long deadManStartTime = 0;
const unsigned long DEAD_MAN_TIMEOUT = 20000; // 20 segundos
bool deadManConfirmadoVent = false;
bool deadManConfirmadoLuz = false;
bool deadManConfirmadoRiego = false;

// --- PUNTOS DE AJUSTE AUTOMÁTICOS (Ajustado para Frutillas/Fresas) ---
const float TEMP_VENT_ON = 26.0;   // Extractor ON si es mayor a 26°C
const float TEMP_VENT_OFF = 24.0;  // Extractor OFF si baja a 24°C
const float TEMP_CAL_ON = 16.0;    // Calefacción ON si baja de 16°C
const float TEMP_CAL_OFF = 18.0;   // Calefacción OFF si sube a 18°C
const int HUM_SUELO_MIN = 50;      // Riego ON si es menor o igual al 50%
const int HUM_SUELO_MAX = 70;      // Riego OFF al alcanzar el 70%

// --- CONFIGURACIÓN DE OBJETOS DE FIREBASE ---
FirebaseData fbdo_send;   // Objeto para envío de datos
FirebaseData fbdo_stream; // Objeto para el flujo de recepción en tiempo real
FirebaseAuth auth;
FirebaseConfig config;

// --- DECLARACIONES DE FUNCIONES ---
void conectarWiFi();
void inicializarFirebase();
void verificarSeguridadYLimites();
void verificarSujetoMuerto();
void actualizarFirebase();
void streamCallback(StreamData data); // Usa la sintaxis correcta StreamData
void streamTimeoutCallback(bool timeout);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== INVERNADERO INTELIGENTE CLOUD ===");
  
  // Configuración de pines de relé y PIR
  pinMode(PIN_RELE_VENT, OUTPUT);
  pinMode(PIN_RELE_LUZ, OUTPUT);
  pinMode(PIN_RELE_RIEGO, OUTPUT);
  pinMode(PIN_PIR, INPUT);
  
  // Apagar todos los relés al arrancar (Active LOW -> HIGH)
  digitalWrite(PIN_RELE_VENT, RELE_OFF);
  digitalWrite(PIN_RELE_LUZ, RELE_OFF);
  digitalWrite(PIN_RELE_RIEGO, RELE_OFF);
  
  // Inicializar sensor DHT
  dht.begin();
  // Conectar a Wi-Fi
  conectarWiFi();
  // Inicializar Firebase
  inicializarFirebase();
  mensajeSistema = "Sistema listo y conectado a la nube.";
  actualizarFirebase();
}

void loop() {
  // Comprobar la conexión de Firebase y reanudar si es necesario
  if (Firebase.ready()) {
    unsigned long tiempoActual = millis();
    // LECTURA DE SENSORES Y LÓGICA AUTOMÁTICA (Cada 3 segundos)
    if (tiempoActual - ultimoTiempoLectura >= intervaloLectura) {
      ultimoTiempoLectura = tiempoActual;
      
      // 1. --- LECTURA DE SENSORES ---
      int lecturaAnalogica = analogRead(PIN_SUELO);
      int pActual = map(lecturaAnalogica, VALOR_SECO, VALOR_MOJADO, 0, 100);
      humedadSuelo = constrain(pActual, 0, 100);
      
      float t = dht.readTemperature();
      if (!isnan(t)) {
        temperatura = round(t * 10.0) / 10.0;
        Serial.print("Temp: "); Serial.print(temperatura); Serial.println(" °C");
      } else {
        Serial.println("Error leyendo DHT11.");
      }
      Serial.print("Humedad Suelo: "); Serial.print(humedadSuelo); Serial.println("%");
      
      // 2. --- LECTURA DEL SENSOR PIR (Movimiento) ---
      int lecturaPir = digitalRead(PIN_PIR);
      if (lecturaPir == HIGH) {
        if (!movimientoDetectado) {
          movimientoDetectado = true;
          if (seguridadPIR) {
            // Forzar encendido de luz físicamente (relé en pin 2) y registrar tiempo
            digitalWrite(PIN_RELE_LUZ, RELE_ON);
            inicioLuz = tiempoActual;
            mensajeSistema = "ALERTA: ¡Intrusión detectada! Luces encendidas por seguridad.";
            Serial.println("PIR: ¡Intrusión! Encendiendo Luces.");
          } else {
            mensajeSistema = "ALERTA: ¡Movimiento detectado en el invernadero!";
            Serial.println("PIR: ¡Movimiento DETECTADO!");
          }
        }
        ultimoMovimientoTiempo = tiempoActual;
      } else {
        if (movimientoDetectado && (tiempoActual - ultimoMovimientoTiempo >= TIMEOUT_PIR)) {
          movimientoDetectado = false;
          mensajeSistema = "Security OK. Sin presencia.";
          Serial.println("PIR: Área despejada.");
          
          // Si las luces se encendieron debido al PIR, las apagamos al despejar el área
          if (seguridadPIR) {
            // Si el modo automático está activo y hace frío, la dejamos encendida por lógica de cultivo
            if (modoAutomatico && temperatura < TEMP_CAL_ON) {
              mensajeSistema = "Security OK. Calefacción activa por frío.";
            } else {
              digitalWrite(PIN_RELE_LUZ, RELE_OFF);
              inicioLuz = 0;
            }
          }
        }
      }
      
      // 3. --- LÓGICA AUTOMÁTICA ---
      if (modoAutomatico) {
        // Control de Ventilación
        if (temperatura > TEMP_VENT_ON) {
          if (digitalRead(PIN_RELE_VENT) == RELE_OFF) {
            digitalWrite(PIN_RELE_VENT, RELE_ON);
            inicioVent = tiempoActual;
            mensajeSistema = "AUTO: Ventilación ON por calor (> 26°C).";
          }
        } else if (temperatura <= TEMP_VENT_OFF) {
          if (digitalRead(PIN_RELE_VENT) == RELE_ON) {
            digitalWrite(PIN_RELE_VENT, RELE_OFF);
            inicioVent = 0;
            mensajeSistema = "AUTO: Ventilación OFF por clima óptimo.";
          }
        }
        
        // Control de Calefacción / Luz
        if (temperatura < TEMP_CAL_ON) {
          if (digitalRead(PIN_RELE_LUZ) == RELE_OFF) {
            digitalWrite(PIN_RELE_LUZ, RELE_ON);
            inicioLuz = tiempoActual;
            mensajeSistema = "AUTO: Calefacción ON por frío (< 16°C).";
          }
        } else if (temperatura >= TEMP_CAL_OFF) {
          if (digitalRead(PIN_RELE_LUZ) == RELE_ON) {
            digitalWrite(PIN_RELE_LUZ, RELE_OFF);
            inicioLuz = 0;
            mensajeSistema = "AUTO: Calefacción OFF por clima óptimo.";
          }
        }
        
        // Control de Riego
        if (humedadSuelo <= HUM_SUELO_MIN) {
          if (digitalRead(PIN_RELE_RIEGO) == RELE_OFF) {
            digitalWrite(PIN_RELE_RIEGO, RELE_ON);
            inicioRiego = tiempoActual;
            mensajeSistema = "AUTO: Riego iniciado por baja humedad (< 50%).";
          }
        } else if (humedadSuelo >= HUM_SUELO_MAX) {
          if (digitalRead(PIN_RELE_RIEGO) == RELE_ON) {
            digitalWrite(PIN_RELE_RIEGO, RELE_OFF);
            inicioRiego = 0;
            mensajeSistema = "AUTO: Riego detenido por humedad óptima (> 70%).";
          }
        }
      }
      
      // 4. --- SEGURIDAD LOCAL Y ACTUALIZACIÓN EN LA NUBE ---
      verificarSecurityYLimites();
      verificarSujetoMuerto();
      actualizarFirebase();
    }
  }
}

void conectarWiFi() {
  Serial.print("Conectando a Wi-Fi: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi Conectado con éxito.");
    Serial.print("Dirección IP local: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nFallo crítico al conectar al Wi-Fi doméstico. Reintentando de fondo...");
  }
}

void inicializarFirebase() {
  Serial.println("Inicializando Firebase...");
  
  config.database_url = FIREBASE_HOST;
  config.signer.tokens.legacy_token = FIREBASE_AUTH;
  
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  
  if (!Firebase.beginStream(fbdo_stream, "/")) {
    Serial.printf("Error al iniciar Stream de Firebase: %s\n", fbdo_stream.errorReason().c_str());
  } else {
    Serial.println("Stream de Firebase iniciado con éxito.");
    Firebase.setStreamCallback(fbdo_stream, streamCallback, streamTimeoutCallback);
  }
}

void actualizarFirebase() {
  int timeLeft = 0;
  if (deadManActivo) {
    long elapsed = millis() - deadManStartTime;
    timeLeft = (DEAD_MAN_TIMEOUT - elapsed) / 1000;
    if (timeLeft < 0) timeLeft = 0;
  }
  FirebaseJson json;
  json.set("temperatura", temperatura);
  json.set("humedadSuelo", humedadSuelo);
  json.set("movimientoDetectado", movimientoDetectado);
  json.set("seguridadPIR", seguridadPIR);
  json.set("modoAutomatico", modoAutomatico);
  json.set("releVentilacion", digitalRead(PIN_RELE_VENT) == RELE_ON);
  json.set("releLuz", digitalRead(PIN_RELE_LUZ) == RELE_ON);
  json.set("releRiego", digitalRead(PIN_RELE_RIEGO) == RELE_ON);
  json.set("mensajeSistema", mensajeSistema);
  json.set("deadManActivo", deadManActivo);
  json.set("deadManTimeLeft", timeLeft);
  
  if (Firebase.updateNode(fbdo_send, "/", json)) {
    Serial.println("Firebase actualizado con éxito.");
  } else {
    Serial.print("Error al actualizar Firebase: ");
    Serial.println(fbdo_send.errorReason());
  }
}

// Recibe correctamente (StreamData data) compatible con Firebase ESP32 Client
void streamCallback(StreamData data) {
  if (data.dataType() == "json") {
    FirebaseJson *json = data.jsonObjectPtr();
    FirebaseJsonData jsonData;
    
    if (json->get(jsonData, "modoAutomatico")) {
      modoAutomatico = jsonData.boolValue;
    }
    if (json->get(jsonData, "seguridadPIR")) {
      seguridadPIR = jsonData.boolValue;
    }
    
    if (temperatura <= 28.5) {
      if (json->get(jsonData, "releVentilacion")) {
        digitalWrite(PIN_RELE_VENT, jsonData.boolValue ? RELE_ON : RELE_OFF);
      }
      if (json->get(jsonData, "releLuz")) {
        digitalWrite(PIN_RELE_LUZ, jsonData.boolValue ? RELE_ON : RELE_OFF);
      }
      if (json->get(jsonData, "releRiego")) {
        digitalWrite(PIN_RELE_RIEGO, jsonData.boolValue ? RELE_ON : RELE_OFF);
      }
    }
    return;
  }
  
  if (temperatura > 28.5) {
    if (data.dataPath() == "/releVentilacion" || data.dataPath() == "/releLuz" || data.dataPath() == "/releRiego" || data.dataPath() == "/modoAutomatico") {
      Serial.println("Bloqueo térmico activo. Comando de Firebase denegado.");
      mensajeSistema = "BLOQUEO: ¡Temperatura crítica! Comando remoto rechazado.";
      actualizarFirebase();
      return;
    }
  }
  
  String path = data.dataPath();
  bool value = data.boolData();
  unsigned long ahora = millis();
  Serial.print("Stream: Cambio en "); Serial.print(path); Serial.print(" -> "); Serial.println(value);
  
  if (path == "/modoAutomatico") {
    modoAutomatico = value;
    if (modoAutomatico) {
      deadManActivo = false;
      mensajeSistema = "NUBE: Cambiado a modo AUTOMÁTICO por usuario.";
    } else {
      mensajeSistema = "NUBE: Cambiado a modo MANUAL por usuario.";
    }
  } 
  else if (path == "/seguridadPIR") {
    seguridadPIR = value;
    mensajeSistema = seguridadPIR ? "NUBE: Luces por presencia activadas." : "NUBE: Luces por presencia desactivadas.";
  }
  else if (path == "/releVentilacion") {
    modoAutomatico = false;
    digitalWrite(PIN_RELE_VENT, value ? RELE_ON : RELE_OFF);
    inicioVent = value ? ahora : 0;
    deadManConfirmadoVent = false;
    mensajeSistema = value ? "NUBE: Ventilador encendido manualmente." : "NUBE: Ventilador apagado manualmente.";
  } 
  else if (path == "/releLuz") {
    modoAutomatico = false;
    digitalWrite(PIN_RELE_LUZ, value ? RELE_ON : RELE_OFF);
    inicioLuz = value ? ahora : 0;
    deadManConfirmadoLuz = false;
    mensajeSistema = value ? "NUBE: Calefacción encendida manualmente." : "NUBE: Calefacción apagada manualmente.";
  } 
  else if (path == "/releRiego") {
    modoAutomatico = false;
    digitalWrite(PIN_RELE_RIEGO, value ? RELE_ON : RELE_OFF);
    inicioRiego = value ? ahora : 0;
    deadManConfirmadoRiego = false;
    mensajeSistema = value ? "NUBE: Bomba de riego encendida manualmente." : "NUBE: Bomba de riego apagada manualmente.";
  }
  else if (path == "/deadManConfirmado") {
    if (value && deadManActivo) {
      deadManActivo = false;
      
      if (digitalRead(PIN_RELE_VENT) == RELE_ON && temperatura <= TEMP_VENT_OFF) {
        deadManConfirmadoVent = true;
      }
      if (digitalRead(PIN_RELE_LUZ) == RELE_ON && temperatura >= TEMP_CAL_OFF) {
        deadManConfirmadoLuz = true;
      }
      if (digitalRead(PIN_RELE_RIEGO) == RELE_ON && humedadSuelo >= HUM_SUELO_MAX) {
        deadManConfirmadoRiego = true;
      }
      mensajeSistema = "NUBE: Sujeto muerto confirmado. Control manual retenido.";
      Serial.println("Sujeto Muerto CONFIRMADO vía Firebase.");
      
      Firebase.setBool(fbdo_send, "/deadManConfirmado", false);
    }
  }
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) {
    Serial.println("Stream de Firebase timed out. Reanudando...");
  }
}

void verificarSecurityYLimites() {
  unsigned long ahora = millis();
  if (temperatura > 28.5) {
    modoAutomatico = true;
    deadManActivo = false;
    digitalWrite(PIN_RELE_VENT, RELE_ON);
    if (inicioVent == 0) inicioVent = ahora;
    digitalWrite(PIN_RELE_LUZ, RELE_OFF);
    inicioLuz = 0;
    mensajeSistema = "BLOQUEO: ¡Temperatura crítica (>28.5°C)! Controles bloqueados.";
    return;
  }
  
  if (digitalRead(PIN_RELE_RIEGO) == RELE_ON) {
    if (inicioRiego == 0) inicioRiego = ahora;
    if (ahora - inicioRiego > LIMITE_SEGURIDAD) {
      digitalWrite(PIN_RELE_RIEGO, RELE_OFF);
      inicioRiego = 0;
      modoAutomatico = true; 
      mensajeSistema = "PELIGRO: Bomba apagada por seguridad (límite 7 min). ¿Fuga?";
    }
  } else {
    inicioRiego = 0;
  }
  
  if (digitalRead(PIN_RELE_VENT) == RELE_ON) {
    if (inicioVent == 0) inicioVent = ahora;
    if (ahora - inicioVent > LIMITE_SEGURIDAD) {
      digitalWrite(PIN_RELE_VENT, RELE_OFF);
      inicioVent = 0;
      modoAutomatico = true;
      mensajeSistema = "SEGURIDAD: Ventilación apagada por límite de 7 min.";
    }
  } else {
    inicioVent = 0;
  }
  
  if (digitalRead(PIN_RELE_LUZ) == RELE_ON) {
    if (inicioLuz == 0) inicioLuz = ahora;
    if (ahora - inicioLuz > LIMITE_SEGURIDAD) {
      digitalWrite(PIN_RELE_LUZ, RELE_OFF);
      inicioLuz = 0;
      modoAutomatico = true;
      mensajeSistema = "SEGURIDAD: Calefacción apagada por límite de 7 min.";
    }
  } else {
    inicioLuz = 0;
  }
}

void verificarSujetoMuerto() {
  if (modoAutomatico) {
    deadManActivo = false;
    return;
  }
  unsigned long ahora = millis();
  bool necesitaConfirmacion = false;
  
  bool riegoOptimo = (digitalRead(PIN_RELE_RIEGO) == RELE_ON && humedadSuelo >= HUM_SUELO_MAX);
  bool ventOptima = (digitalRead(PIN_RELE_VENT) == RELE_ON && temperatura <= TEMP_VENT_OFF);
  bool luzOptima = (digitalRead(PIN_RELE_LUZ) == RELE_ON && temperatura >= TEMP_CAL_OFF);
  
  if (riegoOptimo && !deadManConfirmadoRiego) necesitaConfirmacion = true;
  if (ventOptima && !deadManConfirmadoVent) necesitaConfirmacion = true;
  if (luzOptima && !deadManConfirmadoLuz) necesitaConfirmacion = true;
  
  if (necesitaConfirmacion) {
    if (!deadManActivo) {
      deadManActivo = true;
      deadManStartTime = ahora;
      mensajeSistema = "AVISO: Clima óptimo. Confirma presencia en 20s o volverá a AUTO.";
      Serial.println("¡Sujeto Muerto ACTIVADO!");
    }
    if (ahora - deadManStartTime >= DEAD_MAN_TIMEOUT) {
      deadManActivo = false;
      modoAutomatico = true;
      
      digitalWrite(PIN_RELE_VENT, RELE_OFF);
      digitalWrite(PIN_RELE_LUZ, RELE_OFF);
      digitalWrite(PIN_RELE_RIEGO, RELE_OFF);
      
      deadManConfirmadoVent = false;
      deadManConfirmadoLuz = false;
      deadManConfirmadoRiego = false;
      mensajeSistema = "SEGURIDAD: Retorno forzado a modo AUTO (Sujeto Muerto expirado).";
      Serial.println("Sujeto Muerto EXPIRADO. Modo cambiado a AUTO.");
    }
  } else {
    if (!riegoOptimo) deadManConfirmadoRiego = false;
    if (!ventOptima) deadManConfirmadoVent = false;
    if (!luzOptima) deadManConfirmadoLuz = false;
    
    if (!riegoOptimo && !ventOptima && !luzOptima) {
      deadManActivo = false;
    }
  }
}
