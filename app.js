// -------------------------------------------------------------
// BioShield Greenhouse Control Engine (app.js) - Versión Cloud Firebase
// Supports Hybrid Modes: Live Firebase RTDB vs. High-Fidelity Simulator
// -------------------------------------------------------------

// --- VARIABLES DE ESTADO ---
let isSimulatorMode = true; // Por defecto inicia en SIMULADOR para pruebas inmediatas
let firebaseDbUrl = "";
let firebaseAuthToken = "";
let db = null; // Referencia de base de datos Firebase Realtime
let dataRef = null;

let simInterval = null;

// Datos de Estado Actuales (Sincronizados)
let systemState = {
    temp: 25.0,
    moisture: 50,
    relay_vent: 0,
    relay_light: 0,
    relay_riego: 0,
    mode: "AUTO", // AUTO o MANUAL
    dead_man_active: false,
    dead_man_time_left: 20,
    movimientoDetectado: false,
    seguridadPIR: false,
    system_message: "Sistema iniciado. Por favor, configura tu Firebase en el panel derecho."
};

// Historial para cálculo de tendencias
let prevTemp = 25.0;
let prevMoisture = 50;

// Variables específicas de la simulación
let simDeadManConfirmedVent = false;
let simDeadManConfirmedLuz = false;
let simDeadManConfirmedRiego = false;
let simDeadManCounter = 20;
let simPirTimeout = null;

// Audio alerts generator (Web Audio API Synthesizer)
let audioCtx = null;

// --- SELECTORES DOM ---
const elTemp = document.getElementById("val-temp");
const elBarTemp = document.getElementById("bar-temp");
const elTempTrend = document.getElementById("temp-trend");

const elMoisture = document.getElementById("val-moisture");
const elBarMoisture = document.getElementById("bar-moisture");
const elMoistureTrend = document.getElementById("moisture-trend");

// Selectores para el Sensor PIR
const elPirCard = document.getElementById("pir-card");
const elPirVisual = document.getElementById("pir-visual");
const elPirIcon = document.getElementById("pir-icon");
const elValPir = document.getElementById("val-pir");
const elPirStatusDot = document.getElementById("pir-status-dot");
const elSwitchPirLight = document.getElementById("switch-pir-light");

const elSystemMessage = document.getElementById("system-message");
const elSystemMessageCard = document.querySelector(".system-message-card");
const elConnectionBadge = document.getElementById("connection-badge");
const elCloudInfoUrl = document.getElementById("firebase-connected-url");

const elModeAuto = document.getElementById("mode-auto");
const elModeManual = document.getElementById("mode-manual");

const elSwitchVent = document.getElementById("switch-vent");
const elSwitchLight = document.getElementById("switch-light");
const elSwitchRiego = document.getElementById("switch-riego");

const elRowVent = document.getElementById("row-vent");
const elRowLight = document.getElementById("row-light");
const elRowRiego = document.getElementById("row-riego");
const elActuatorsCard = document.querySelector(".actuators-card");
const elManualLockedIndicator = document.getElementById("manual-locked-indicator");

const elThermalBanner = document.getElementById("thermal-lockout-banner");

// Configuración de Firebase
const elFirebaseForm = document.getElementById("firebase-form");
const elFbDbUrlInput = document.getElementById("fb-db-url");
const elFbAuthTokenInput = document.getElementById("fb-auth-token");

// Selector modo Real / Simulador
const elBtnToggleSim = document.getElementById("btn-toggle-simulator");
const elSimSettingsCard = document.getElementById("simulator-settings-card");
const elSimTempSlider = document.getElementById("sim-temp");
const elSimMoistureSlider = document.getElementById("sim-moisture");
const elSimTempDisplay = document.getElementById("sim-temp-display");
const elSimMoistureDisplay = document.getElementById("sim-moisture-display");
const elBtnSimPir = document.getElementById("btn-sim-pir");
const elSimPirDisplay = document.getElementById("sim-pir-display");

// Presets simulador
const elPresetFreeze = document.getElementById("preset-freeze");
const elPresetHot = document.getElementById("preset-hot");
const elPresetDry = document.getElementById("preset-dry");

// Modal Sujeto Muerto
const elDeadManModal = document.getElementById("dead-man-modal");
const elDeadManTimerDisplay = document.getElementById("dead-man-timer-display");
const elTimerNumberSeconds = document.getElementById("timer-number-seconds");
const elTimerCircleProgress = document.getElementById("timer-circle-progress");
const elBtnConfirmDeadMan = document.getElementById("btn-confirm-dead-man");

// --- INICIALIZACIÓN ---
document.addEventListener("DOMContentLoaded", () => {
    // Cargar credenciales de Firebase guardadas si existen
    const savedUrl = localStorage.getItem("firebase_db_url");
    const savedToken = localStorage.getItem("firebase_auth_token");
    
    if (savedUrl) {
        firebaseDbUrl = savedUrl;
        elFbDbUrlInput.value = firebaseDbUrl;
        elCloudInfoUrl.textContent = cleanUrlForDisplay(firebaseDbUrl);
    }
    if (savedToken) {
        firebaseAuthToken = savedToken;
        elFbAuthTokenInput.value = firebaseAuthToken;
    }

    // Listener de Guardado de Credenciales de Firebase
    elFirebaseForm.addEventListener("submit", (e) => {
        e.preventDefault();
        firebaseDbUrl = elFbDbUrlInput.value.trim();
        firebaseAuthToken = elFbAuthTokenInput.value.trim();

        // Asegurar que la URL termine con una barra
        if (!firebaseDbUrl.endsWith("/")) {
            firebaseDbUrl += "/";
        }

        localStorage.setItem("firebase_db_url", firebaseDbUrl);
        localStorage.setItem("firebase_auth_token", firebaseAuthToken);
        elCloudInfoUrl.textContent = cleanUrlForDisplay(firebaseDbUrl);

        alert("Credenciales de Firebase guardadas.");

        if (!isSimulatorMode) {
            conectarFirebaseRealtime();
        }
    });

    // Toggle de Modo Real (Cloud) vs Simulador
    elBtnToggleSim.addEventListener("click", toggleModeSimulator);

    // Eventos Radio Button Modo AUTO / MANUAL
    elModeAuto.addEventListener("change", () => setSystemMode("auto"));
    elModeManual.addEventListener("change", () => setSystemMode("manual"));

    // Eventos de Switches de Actuadores
    elSwitchVent.addEventListener("change", (e) => setActuatorState("vent", e.target.checked ? 1 : 0));
    elSwitchLight.addEventListener("change", (e) => setActuatorState("light", e.target.checked ? 1 : 0));
    elSwitchRiego.addEventListener("change", (e) => setActuatorState("irrigation", e.target.checked ? 1 : 0));

    // Evento de Switch de Encendido de Luz por PIR
    elSwitchPirLight.addEventListener("change", (e) => {
        const isChecked = e.target.checked;
        if (isSimulatorMode) {
            systemState.seguridadPIR = isChecked;
            systemState.system_message = isChecked ? "SIMULADOR: Luces por presencia activadas." : "SIMULADOR: Luces por presencia desactivadas.";
            renderState();
        } else {
            if (db) {
                db.ref("/seguridadPIR").set(isChecked);
            }
        }
    });

    // Confirmación del Sujeto Muerto
    elBtnConfirmDeadMan.addEventListener("click", confirmUserPresence);

    // Configuración del Simulador (Sliders)
    elSimTempSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        elSimTempDisplay.textContent = val.toFixed(1) + " °C";
        systemState.temp = val;
    });

    elSimMoistureSlider.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        elSimMoistureDisplay.textContent = val + "%";
        systemState.moisture = val;
    });

    // Simular PIR en el simulador
    elBtnSimPir.addEventListener("click", triggerSimulatedPIR);

    // Botones de Preset del Simulador
    elPresetFreeze.addEventListener("click", () => {
        elSimTempSlider.value = 15.0;
        systemState.temp = 15.0;
        elSimTempDisplay.textContent = "15.0 °C";
    });
    elPresetHot.addEventListener("click", () => {
        elSimTempSlider.value = 29.0;
        systemState.temp = 29.0;
        elSimTempDisplay.textContent = "29.0 °C";
    });
    elPresetDry.addEventListener("click", () => {
        elSimMoistureSlider.value = 25;
        systemState.moisture = 25;
        elSimMoistureDisplay.textContent = "25%";
    });

    // Iniciar bucle por defecto
    inicializarConexiones();
});

// Limpiar la URL para mostrarla en el footer
function cleanUrlForDisplay(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname;
    } catch (e) {
        return url.substring(0, 30) + "...";
    }
}

// --- GENERADOR DE AUDIO ALERTA SINTETIZADO ---
function playAlertBeep(type) {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        if (type === 'critical') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(440, audioCtx.currentTime);
            osc.frequency.linearRampToValueAtTime(880, audioCtx.currentTime + 0.5);
            gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
            gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.5);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.5);
        } else {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
            gain.gain.setValueAtTime(0, audioCtx.currentTime + 0.15);
            
            osc.start();
            osc.stop(audioCtx.currentTime + 0.2);
        }
    } catch (e) {
        // Ignorar restricciones del navegador
    }
}

// --- CONMUTADOR DE MODO SIMULADOR VS REAL ---
function toggleModeSimulator() {
    isSimulatorMode = !isSimulatorMode;
    
    if (isSimulatorMode) {
        elBtnToggleSim.className = "btn-mode simulator";
        elBtnToggleSim.innerHTML = '<i class="fa-solid fa-laptop-code"></i> SIMULADOR';
        elSimSettingsCard.classList.remove("hidden");
        
        elConnectionBadge.className = "badge-status simulating";
        elConnectionBadge.querySelector(".badge-text").textContent = "Simulando";
        
        systemState.system_message = "Cambiado a Modo Simulador. Sensores controlados localmente.";
    } else {
        elBtnToggleSim.className = "btn-mode esp32";
        elBtnToggleSim.innerHTML = '<i class="fa-solid fa-cloud"></i> MODO CLOUD REAL';
        elSimSettingsCard.classList.add("hidden");
        
        elConnectionBadge.className = "badge-status disconnected";
        elConnectionBadge.querySelector(".badge-text").textContent = "Desconectado";
        
        systemState.system_message = "Conectando con base de datos de Firebase...";
    }
    
    inicializarConexiones();
}

function inicializarConexiones() {
    // Detener intervalos
    if (simInterval) clearInterval(simInterval);
    
    // Si hay suscripción a Firebase previa, apagarla
    if (dataRef) {
        dataRef.off();
        dataRef = null;
    }

    if (isSimulatorMode) {
        // Sincronizar Sliders
        elSimTempSlider.value = systemState.temp;
        elSimMoistureSlider.value = systemState.moisture;
        elSimTempDisplay.textContent = systemState.temp.toFixed(1) + " °C";
        elSimMoistureDisplay.textContent = systemState.moisture + "%";

        // Lanzar motor del simulador
        simInterval = setInterval(runSimulationStep, 1000);
        
        elConnectionBadge.className = "badge-status simulating";
        elConnectionBadge.querySelector(".badge-text").textContent = "Simulando";
        renderState();
    } else {
        // Conectar a Firebase
        conectarFirebaseRealtime();
    }
}

// -------------------------------------------------------------
// --- CONEXIÓN DE FIREBASE REALTIME DATABASE ---
// -------------------------------------------------------------
function conectarFirebaseRealtime() {
    if (!firebaseDbUrl) {
        elConnectionBadge.className = "badge-status disconnected";
        elConnectionBadge.querySelector(".badge-text").textContent = "Sin Configurar";
        systemState.system_message = "Firebase no configurado. Escribe la URL de tu base de datos en la tarjeta derecha.";
        renderState();
        return;
    }

    try {
        // Inicializar o re-inicializar App
        if (firebase.apps.length > 0) {
            firebase.app().delete();
        }

        const config = {
            databaseURL: firebaseDbUrl
        };

        firebase.initializeApp(config);
        db = firebase.database();
        dataRef = db.ref("/");

        elConnectionBadge.className = "badge-status disconnected";
        elConnectionBadge.querySelector(".badge-text").textContent = "Conectando...";
        systemState.system_message = "Conectando en tiempo real con Firebase...";
        renderState();

        // Escuchar datos de Firebase en tiempo real
        dataRef.on("value", (snapshot) => {
            const data = snapshot.val();
            if (data) {
                // Sincronización de variables recibidas
                systemState.temp = data.temperatura !== undefined ? parseFloat(data.temperatura) : systemState.temp;
                systemState.moisture = data.humedadSuelo !== undefined ? parseInt(data.humedadSuelo) : systemState.moisture;
                systemState.relay_vent = data.releVentilacion ? 1 : 0;
                systemState.relay_light = data.releLuz ? 1 : 0;
                systemState.relay_riego = data.releRiego ? 1 : 0;
                systemState.mode = data.modoAutomatico ? "AUTO" : "MANUAL";
                systemState.dead_man_active = data.deadManActivo || false;
                systemState.dead_man_time_left = data.deadManTimeLeft !== undefined ? parseInt(data.deadManTimeLeft) : 20;
                systemState.system_message = data.mensajeSistema || systemState.system_message;
                systemState.movimientoDetectado = data.movimientoDetectado || false;
                systemState.seguridadPIR = data.seguridadPIR || false;

                // Conexión exitosa
                elConnectionBadge.className = "badge-status connected";
                elConnectionBadge.querySelector(".badge-text").textContent = "En Línea";
                renderState();
            } else {
                // Si la BD está vacía, inicializar la estructura
                systemState.system_message = "Base de datos en la nube vacía. Esperando datos del ESP32...";
                renderState();
            }
        }, (error) => {
            console.error("Error en conexión Firebase:", error);
            elConnectionBadge.className = "badge-status disconnected";
            elConnectionBadge.querySelector(".badge-text").textContent = "Error de Acceso";
            systemState.system_message = "Error de permisos en Firebase. Revisa la pestaña 'Reglas' de tu base de datos.";
            renderState();
        });

    } catch (e) {
        console.error("Fallo al inicializar Firebase SDK:", e);
        elConnectionBadge.className = "badge-status disconnected";
        elConnectionBadge.querySelector(".badge-text").textContent = "Fallo de SDK";
        systemState.system_message = "Error crítico de inicialización. Verifica que la URL ingresada sea válida.";
        renderState();
    }
}

// -------------------------------------------------------------
// --- CONTROLADOR DEL SIMULADOR FISICO LOCAL ---
// -------------------------------------------------------------
function runSimulationStep() {
    let temp = systemState.temp;
    let moisture = systemState.moisture;
    let vent = systemState.relay_vent;
    let light = systemState.relay_light;
    let riego = systemState.relay_riego;

    // --- FÍSICA SIMULADA ---
    if (riego === 1) {
        moisture += 1.5;
    } else {
        moisture -= 0.08;
    }
    moisture = Math.max(10, Math.min(90, Math.round(moisture)));

    if (vent === 1) {
        temp -= 0.25;
    }
    if (light === 1) {
        temp += 0.18;
    }
    
    if (vent === 0 && light === 0) {
        if (temp > 24.5) temp -= 0.02;
        else if (temp < 24.5) temp += 0.02;
    }
    temp = Math.max(15, Math.min(35, parseFloat(temp.toFixed(2))));

    systemState.temp = temp;
    systemState.moisture = moisture;

    // Lógica adicional para seguridad PIR en el simulador
    if (systemState.movimientoDetectado && systemState.seguridadPIR) {
        systemState.relay_light = 1;
        systemState.system_message = "ALERTA: ¡Intrusión detectada! Luces encendidas por seguridad.";
    }

    // --- LÓGICA AUTOMÁTICA DEL SIMULADOR ---
    if (systemState.mode === "AUTO") {
        simDeadManConfirmedVent = false;
        simDeadManConfirmedLuz = false;
        simDeadManConfirmedRiego = false;
        systemState.dead_man_active = false;
        simDeadManCounter = 20;

        if (temp > 28.5) {
            systemState.relay_vent = 1;
            systemState.relay_light = 0;
            systemState.system_message = "BLOQUEO: ¡Temperatura crítica (>28.5°C)! Controles bloqueados.";
        } else {
            // Ventilación
            if (temp > 26.0) {
                systemState.relay_vent = 1;
                systemState.system_message = "AUTO: Ventilación ON por calor (>26°C).";
            } else if (temp <= 24.0) {
                systemState.relay_vent = 0;
                systemState.system_message = "AUTO: Ventilación OFF por clima óptimo.";
            }

            // Calefacción
            if (temp < 16.0) {
                systemState.relay_light = 1;
                systemState.system_message = "AUTO: Calefacción ON por frío (<16°C).";
            } else if (temp >= 18.0) {
                systemState.relay_light = 0;
                systemState.system_message = "AUTO: Calefacción OFF por clima óptimo.";
            }
        }

        // Riego
        if (moisture <= 50) {
            systemState.relay_riego = 1;
            systemState.system_message = "AUTO: Riego iniciado por baja humedad (<50%).";
        } else if (moisture >= 70) {
            systemState.relay_riego = 0;
            systemState.system_message = "AUTO: Riego detenido por humedad óptima (>70%).";
        }
    } 
    // --- LÓGICA MANUAL + SUJETO MUERTO EN SIMULADOR ---
    else {
        if (temp > 28.5) {
            systemState.mode = "AUTO";
            systemState.relay_vent = 1;
            systemState.relay_light = 0;
            systemState.dead_man_active = false;
            systemState.system_message = "BLOQUEO TÉRMICO ACTIVO: Temperatura crítica >28.5°C. Modo MANUAL inhabilitado.";
        } else {
            let riegoOptimo = (riego === 1 && moisture >= 70);
            let ventOptima = (vent === 1 && temp <= 24.0);
            let luzOptima = (light === 1 && temp >= 18.0);

            let necesitaConfirmacion = false;
            if (riegoOptimo && !simDeadManConfirmedRiego) necesitaConfirmacion = true;
            if (ventOptima && !simDeadManConfirmedVent) necesitaConfirmacion = true;
            if (luzOptima && !simDeadManConfirmedLuz) necesitaConfirmacion = true;

            if (necesitaConfirmacion) {
                if (!systemState.dead_man_active) {
                    systemState.dead_man_active = true;
                    simDeadManCounter = 20;
                    systemState.system_message = "AVISO: Clima óptimo. Confirma presencia en 20s o volverá a AUTO.";
                }
                
                simDeadManCounter--;
                systemState.dead_man_time_left = simDeadManCounter;
                
                if (simDeadManCounter % 3 === 0) {
                    playAlertBeep('warning');
                }

                if (simDeadManCounter <= 0) {
                    systemState.dead_man_active = false;
                    systemState.mode = "AUTO";
                    systemState.relay_vent = 0;
                    systemState.relay_light = 0;
                    systemState.relay_riego = 0;
                    
                    simDeadManConfirmedVent = false;
                    simDeadManConfirmedLuz = false;
                    simDeadManConfirmedRiego = false;
                    
                    systemState.system_message = "SEGURIDAD: Retorno forzado a AUTO por inactividad (Sujeto Muerto 20s).";
                }
            } else {
                if (!riegoOptimo) simDeadManConfirmedRiego = false;
                if (!ventOptima) simDeadManConfirmedVent = false;
                if (!luzOptima) simDeadManConfirmedLuz = false;
                
                if (!riegoOptimo && !ventOptima && !luzOptima) {
                    systemState.dead_man_active = false;
                }
            }
        }
    }

    // Actualizar controles visuales en simulación
    elSimTempSlider.value = temp;
    elSimMoistureSlider.value = moisture;
    elSimTempDisplay.textContent = temp.toFixed(1) + " °C";
    elSimMoistureDisplay.textContent = moisture + "%";

    renderState();
}

// Disparar detección del sensor PIR en simulación
function triggerSimulatedPIR() {
    if (!isSimulatorMode) return;
    
    if (simPirTimeout) clearTimeout(simPirTimeout);
    
    systemState.movimientoDetectado = true;
    elSimPirDisplay.textContent = "MOVIMIENTO DETECTADO";
    elSimPirDisplay.style.color = "var(--accent-red)";
    
    if (systemState.seguridadPIR) {
        systemState.relay_light = 1;
        systemState.system_message = "ALERTA: ¡Intrusión detectada! Luces encendidas por seguridad.";
    } else {
        systemState.system_message = "ALERTA: ¡Movimiento detectado en el invernadero!";
    }
    
    renderState();

    // Mantener detección de movimiento por 10 segundos
    simPirTimeout = setTimeout(() => {
        systemState.movimientoDetectado = false;
        systemState.system_message = "Seguridad OK. Sin presencia.";
        elSimPirDisplay.textContent = "Sin Movimiento";
        elSimPirDisplay.style.color = "";
        
        // Si las luces se encendieron por el PIR, las apagamos al despejar la zona
        if (systemState.seguridadPIR) {
            if (systemState.mode === "AUTO" && systemState.temp < 16.0) {
                systemState.system_message = "Seguridad OK. Calefacción activa por frío.";
            } else {
                systemState.relay_light = 0;
            }
        }
        
        renderState();
    }, 10000);
}

// --- CAMBIAR MODO OPERATIVO DE FORMA CLOUD / LOCAL ---
function setSystemMode(modeStr) {
    const autoVal = (modeStr === "auto");
    if (isSimulatorMode) {
        systemState.mode = autoVal ? "AUTO" : "MANUAL";
        systemState.system_message = `MANUAL: Cambiado a modo ${systemState.mode} en simulador.`;
        if (autoVal) {
            systemState.dead_man_active = false;
        }
        renderState();
    } else {
        if (!db) return;
        // Escribir cambio en Firebase
        db.ref("/modoAutomatico").set(autoVal);
        if (autoVal) {
            db.ref("/deadManActivo").set(false);
        }
    }
}

// --- CONTROLAR RELÉS MANUALMENTE (FUERZA MODO MANUAL) ---
function setActuatorState(relayName, stateVal) {
    const booleanState = (stateVal === 1);
    
    if (isSimulatorMode) {
        systemState.mode = "MANUAL"; // Forzar manual
        
        if (relayName === "vent") {
            systemState.relay_vent = stateVal;
            simDeadManConfirmedVent = false;
            systemState.system_message = booleanState ? "MANUAL: Ventilador encendido." : "MANUAL: Ventilador apagado.";
        }
        else if (relayName === "light") {
            systemState.relay_light = stateVal;
            simDeadManConfirmedLuz = false;
            systemState.system_message = booleanState ? "MANUAL: Calefacción encendida." : "MANUAL: Calefacción apagada.";
        }
        else if (relayName === "irrigation") {
            systemState.relay_riego = stateVal;
            simDeadManConfirmedRiego = false;
            systemState.system_message = booleanState ? "MANUAL: Riego encendido." : "MANUAL: Riego apagado.";
        }
        
        renderState();
    } else {
        if (!db) return;
        
        // Poner en manual localmente para evitar retrasos de feedback visual
        systemState.mode = "MANUAL";
        
        // Escribir comandos en Firebase
        const updates = {};
        updates["/modoAutomatico"] = false;
        
        if (relayName === "vent") {
            updates["/releVentilacion"] = booleanState;
        } else if (relayName === "light") {
            updates["/releLuz"] = booleanState;
        } else if (relayName === "irrigation") {
            updates["/releRiego"] = booleanState;
        }
        
        db.ref().update(updates);
    }
}

// --- CONFIRMAR SUJETO MUERTO ---
function confirmUserPresence() {
    if (isSimulatorMode) {
        if (systemState.dead_man_active) {
            systemState.dead_man_active = false;
            
            if (systemState.relay_vent === 1 && systemState.temp <= 24.0) {
                simDeadManConfirmedVent = true;
            }
            if (systemState.relay_light === 1 && systemState.temp >= 18.0) {
                simDeadManConfirmedLuz = true;
            }
            if (systemState.relay_riego === 1 && systemState.moisture >= 70) {
                simDeadManConfirmedRiego = true;
            }

            systemState.system_message = "MANUAL: Presencia confirmada. Reteniendo modo MANUAL.";
            elDeadManModal.classList.add("hidden");
            renderState();
        }
    } else {
        if (!db || !systemState.dead_man_active) return;
        // Escribir confirmación en Firebase
        db.ref("/deadManConfirmado").set(true);
    }
}

// -------------------------------------------------------------
// --- MOTOR DE RENDERIZADO VISUAL (UI UPDATES) ---
// -------------------------------------------------------------
function renderState() {
    // 1. Mostrar Sensores
    elTemp.textContent = systemState.temp.toFixed(1);
    elBarTemp.style.width = Math.min(100, Math.max(0, ((systemState.temp - 15) / 20) * 100)) + "%";

    elMoisture.textContent = systemState.moisture;
    elBarMoisture.style.width = systemState.moisture + "%";

    // 2. Mostrar Tendencias
    if (systemState.temp > prevTemp + 0.05) {
        elTempTrend.className = "trend-indicator up";
        elTempTrend.innerHTML = '<i class="fa-solid fa-arrow-trend-up"></i>';
    } else if (systemState.temp < prevTemp - 0.05) {
        elTempTrend.className = "trend-indicator down";
        elTempTrend.innerHTML = '<i class="fa-solid fa-arrow-trend-down"></i>';
    } else {
        elTempTrend.className = "trend-indicator stable";
        elTempTrend.innerHTML = '<i class="fa-solid fa-equals"></i>';
    }

    if (systemState.moisture > prevMoisture) {
        elMoistureTrend.className = "trend-indicator up";
        elMoistureTrend.innerHTML = '<i class="fa-solid fa-arrow-trend-up"></i>';
    } else if (systemState.moisture < prevMoisture) {
        elMoistureTrend.className = "trend-indicator down";
        elMoistureTrend.innerHTML = '<i class="fa-solid fa-arrow-trend-down"></i>';
    } else {
        elMoistureTrend.className = "trend-indicator stable";
        elMoistureTrend.innerHTML = '<i class="fa-solid fa-equals"></i>';
    }

    prevTemp = systemState.temp;
    prevMoisture = systemState.moisture;

    // 3. Pintar Sensor PIR (Seguridad Perimetral)
    if (systemState.movimientoDetectado) {
        elPirVisual.className = "pir-shield-glow alarm";
        elPirIcon.className = "fa-solid fa-person-running fa-fade";
        elValPir.textContent = "¡MOVIMIENTO DETECTADO!";
        elValPir.className = "pir-value-text alarm-active";
        elPirStatusDot.className = "trend-indicator up";
        elPirStatusDot.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
    } else {
        elPirVisual.className = "pir-shield-glow secured";
        elPirIcon.className = "fa-solid fa-user-shield";
        elValPir.textContent = "Área Protegida";
        elValPir.className = "pir-value-text";
        elPirStatusDot.className = "trend-indicator stable";
        elPirStatusDot.innerHTML = '<i class="fa-solid fa-shield-halved"></i>';
    }

    // 4. Pintar Mensaje del Sistema y Tarjeta
    elSystemMessage.textContent = systemState.system_message;
    
    elSystemMessageCard.className = "system-message-card card-glass";
    if (systemState.system_message.includes("AVISO") || systemState.system_message.includes("ALERTA")) {
        elSystemMessageCard.classList.add("alert-active");
    } else if (systemState.system_message.includes("BLOQUEO") || systemState.system_message.includes("PELIGRO")) {
        elSystemMessageCard.classList.add("critical-active");
    }

    // 5. Configurar Toggles de Modo AUTO vs MANUAL
    if (systemState.mode === "AUTO") {
        elModeAuto.checked = true;
        elSwitchVent.disabled = true;
        elSwitchLight.disabled = true;
        elSwitchRiego.disabled = true;
    } else {
        elModeManual.checked = true;
        
        // Habilitar controles si no estamos en bloqueo crítico
        if (systemState.temp <= 28.5) {
            elSwitchVent.disabled = false;
            elSwitchLight.disabled = false;
            elSwitchRiego.disabled = false;
        }
    }

    // Sincronizar estado de switches
    elSwitchVent.checked = (systemState.relay_vent === 1);
    elSwitchLight.checked = (systemState.relay_light === 1);
    elSwitchRiego.checked = (systemState.relay_riego === 1);
    elSwitchPirLight.checked = systemState.seguridadPIR;

    // Activar clases visuales en las filas de los actuadores
    if (systemState.relay_vent === 1) elRowVent.classList.add("active");
    else elRowVent.classList.remove("active");

    if (systemState.relay_light === 1) elRowLight.classList.add("active");
    else elRowLight.classList.remove("active");

    if (systemState.relay_riego === 1) elRowRiego.classList.add("active");
    else elRowRiego.classList.remove("active");

    // 6. Manejar BLOQUEO TÉRMICO CRÍTICO (> 28.5 °C) en la UI
    if (systemState.temp > 28.5) {
        elThermalBanner.classList.remove("hidden");
        elActuatorsCard.classList.add("disabled-lock");
        elManualLockedIndicator.classList.remove("hidden");
        
        elSwitchVent.disabled = true;
        elSwitchLight.disabled = true;
        elSwitchRiego.disabled = true;
        
        elModeAuto.disabled = true;
        elModeManual.disabled = true;

        elDeadManModal.classList.add("hidden");

        // Alerta de audio sirena
        if (Math.round(systemState.temp * 10) % 5 === 0) {
            playAlertBeep('critical');
        }
    } else {
        elThermalBanner.classList.add("hidden");
        elActuatorsCard.classList.remove("disabled-lock");
        elManualLockedIndicator.classList.add("hidden");
        
        elModeAuto.disabled = false;
        elModeManual.disabled = false;
    }

    // 7. Manejar MODAL DE ALERTA DE SUJETO MUERTO (20s)
    if (systemState.dead_man_active && systemState.temp <= 28.5) {
        elDeadManModal.classList.remove("hidden");
        elDeadManTimerDisplay.textContent = systemState.dead_man_time_left;
        elTimerNumberSeconds.textContent = systemState.dead_man_time_left;

        const circumference = 283;
        const offset = circumference - (systemState.dead_man_time_left / 20) * circumference;
        elTimerCircleProgress.style.strokeDashoffset = offset;
    } else {
        elDeadManModal.classList.add("hidden");
    }
}
