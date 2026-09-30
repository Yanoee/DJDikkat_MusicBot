/************************************************************
 * DJ DIKKAT - Music Bot
 * Runtime flags
 * Admin-toggleable maintenance switch (persisted via config-store,
 * restored at startup by index.js)
 * Build 5.0.0
 * Author: Yanoee
 ************************************************************/

let maintenanceMode = false;
let maintenanceMessage = '🛠️ DJ DIKKAT is being updated — please try again in a few minutes!';

function getMaintenance() {
  return { enabled: maintenanceMode, message: maintenanceMessage };
}

function setMaintenance(enabled, message) {
  maintenanceMode = !!enabled;
  if (typeof message === 'string' && message.trim()) {
    maintenanceMessage = message.trim().slice(0, 300);
  }
  return getMaintenance();
}

module.exports = { getMaintenance, setMaintenance };
