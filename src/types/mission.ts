export type RoleType = 'FLIGHT_DIRECTOR' | 'CAPCOM' | 'EECOM' | 'SCIENCE_OFFICER';

export interface RoleDefinition {
  id: RoleType;
  title: string;
  callsign: string;
  badgeColor: string;
  description: string;
  primaryResponsibilities: string[];
  authorizedActions: string[];
}

export interface TelemetryData {
  solarArrayOutput: number;     // % (0 - 100)
  cabinPressure: number;        // kPa (nominal: 101.3)
  oxygenLevel: number;          // % (nominal: 20.9)
  radiationDoseRate: number;    // microSieverts / hr (nominal: 12-25)
  shieldIntegrity: number;      // % (0 - 100)
  trajectoryVariance: number;   // km off nominal
  velocityKmS: number;          // km/s
  distanceFromEarthKm: number;  // km
}

export type IncidentSeverity = 'NOMINAL' | 'ADVISORY' | 'WARNING' | 'CRITICAL';

export interface MissionIncident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  sourceDataset: string;        // E.g. 'NASA DONKI - CME #2026-X4', 'NASA NeoWs Asteroid 2026-SP1'
  timestamp: string;
  description: string;
  telemetryImpact: Partial<TelemetryData>;
  choices: {
    id: string;
    label: string;
    requiredRole: RoleType;
    actionOutcome: string;
    telemetryDelta: Partial<TelemetryData>;
  }[];
  resolved: boolean;
  resolvedBy?: string;
  chosenOption?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  callsign: string;
  role: RoleType;
  message: string;
  type: 'COMMS' | 'TELEMETRY' | 'ALARM' | 'ACTION';
}

export interface NasaApodData {
  title: string;
  explanation: string;
  url: string;
  date: string;
}

export interface NasaAsteroidAlert {
  id: string;
  name: string;
  estimatedDiameterMeters: number;
  isPotentiallyHazardous: boolean;
  closeApproachDate: string;
  missDistanceKm: string;
}
