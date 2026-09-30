/************************************************************
 * DJ DIKKAT - Music Bot
 * Runtime flags
 * Admin-toggleable maintenance switch (persisted via config-store,
 * restored at startup by index.ts)
 * Build 5.2.0
 * Author: Yanoee
 ************************************************************/

export interface Maintenance {
  enabled: boolean;
  message: string;
}

const maintenance: Maintenance = {
  enabled: false,
  message: '🛠️ DJ DIKKAT is being updated — please try again in a few minutes!'
};

export function getMaintenance(): Maintenance {
  return { ...maintenance };
}

export function setMaintenance(enabled: unknown, message?: unknown): Maintenance {
  maintenance.enabled = !!enabled;
  if (typeof message === 'string' && message.trim()) {
    maintenance.message = message.trim().slice(0, 300);
  }
  return getMaintenance();
}
