import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { RoleSelector, ROLES } from './components/RoleSelector';
import { TelemetryDisplay } from './components/TelemetryDisplay';
import { IncidentConsole } from './components/IncidentConsole';
import { NasaDataHub } from './components/NasaDataHub';
import { MissionLog } from './components/MissionLog';
import {
  RoleType,
  TelemetryData,
  MissionIncident,
  LogEntry,
  NasaApodData,
  NasaAsteroidAlert,
} from './types/mission';
import { fetchNasaApod, fetchNearEarthObjects } from './services/nasaApi';

export const App: React.FC = () => {
  const [currentRole, setCurrentRole] = useState<RoleType>('FLIGHT_DIRECTOR');

  // Baseline telemetry
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    solarArrayOutput: 96,
    cabinPressure: 101.3,
    oxygenLevel: 20.9,
    radiationDoseRate: 18,
    shieldIntegrity: 100,
    trajectoryVariance: 0.2,
    velocityKmS: 7.68,
    distanceFromEarthKm: 384400,
  });

  // Active flight anomalies
  const [incidents, setIncidents] = useState<MissionIncident[]>([
    {
      id: 'INC-2026-DONKI-CME',
      title: 'Solar Particle Event (M-Class Coronal Mass Ejection)',
      severity: 'WARNING',
      sourceDataset: 'NASA DONKI Space Weather Event #CME-2026-11-04',
      timestamp: 'T+02:14:30',
      description:
        'NASA Space Weather Database indicates an interplanetary shock wave inbound. Solar proton flux rising. Sensitive avionics and solar arrays are vulnerable to severe degradation if unmitigated.',
      telemetryImpact: {
        solarArrayOutput: 64,
        radiationDoseRate: 85,
        shieldIntegrity: 82,
      },
      choices: [
        {
          id: 'FLIGHT_GO_SHIELD',
          label: 'Authorize Emergency Storm Shelter Mode',
          requiredRole: 'FLIGHT_DIRECTOR',
          actionOutcome: 'Directs crew to aft shielded compartment and commands EECOM to orient panels edge-on.',
          telemetryDelta: {
            radiationDoseRate: 22,
            shieldIntegrity: 90,
            solarArrayOutput: 88,
          },
        },
        {
          id: 'EECOM_FEATHER_PANELS',
          label: 'Feather Solar Arrays & Cross-Tie Secondary Buses',
          requiredRole: 'EECOM',
          actionOutcome: 'Rotates solar gimbals to minimize particle collision and isolates backup battery cells.',
          telemetryDelta: {
            solarArrayOutput: 94,
            radiationDoseRate: 35,
          },
        },
        {
          id: 'CAPCOM_BROADCAST_PROTO',
          label: 'Broadcast Solar Storm Checklist to Spacecraft',
          requiredRole: 'CAPCOM',
          actionOutcome: 'Relays immediate protective instructions to the astronaut crew on secure S-Band link.',
          telemetryDelta: {
            radiationDoseRate: 28,
            shieldIntegrity: 95,
          },
        },
        {
          id: 'SCIENCE_SENSOR_CAL',
          label: 'Deploy Magnetometer Array to Map Solar Wind Wavefront',
          requiredRole: 'SCIENCE_OFFICER',
          actionOutcome: 'Provides exact arrival timing of solar shockwave to optimize protective measures.',
          telemetryDelta: {
            radiationDoseRate: 20,
            solarArrayOutput: 92,
          },
        },
      ],
      resolved: false,
    },
  ]);

  // Chronological flight operations log
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: '1',
      timestamp: '00:00:01',
      callsign: 'SYSTEM',
      role: 'FLIGHT_DIRECTOR',
      message: 'Code2Larp Mission Control System initialized. DSN telemetry carrier locked.',
      type: 'COMMS',
    },
    {
      id: '2',
      timestamp: '00:00:05',
      callsign: 'FLIGHT',
      role: 'FLIGHT_DIRECTOR',
      message: 'All stations, this is FLIGHT. Status check for orbital transit phase.',
      type: 'COMMS',
    },
    {
      id: '3',
      timestamp: '00:00:12',
      callsign: 'EECOM',
      role: 'EECOM',
      message: 'EECOM reports electrical buses and life support scrubbers nominal.',
      type: 'COMMS',
    },
    {
      id: '4',
      timestamp: '00:01:45',
      callsign: 'ALARM',
      role: 'SCIENCE_OFFICER',
      message: 'ALERT: NASA DONKI reports Coronal Mass Ejection shock front approaching vehicle!',
      type: 'ALARM',
    },
  ]);

  // NASA Data State
  const [apod, setApod] = useState<NasaApodData | null>(null);
  const [asteroids, setAsteroids] = useState<NasaAsteroidAlert[]>([]);
  const [isLoadingNasa, setIsLoadingNasa] = useState(true);

  useEffect(() => {
    async function loadNasaFeeds() {
      setIsLoadingNasa(true);
      const [apodData, neoData] = await Promise.all([
        fetchNasaApod(),
        fetchNearEarthObjects(),
      ]);
      setApod(apodData);
      setAsteroids(neoData);
      setIsLoadingNasa(false);
    }
    loadNasaFeeds();
  }, []);

  const activeRoleDefinition = ROLES.find((r) => r.id === currentRole)!;

  // Resolve an anomaly choice
  const handleResolveIncident = (incidentId: string, choiceId: string) => {
    const incident = incidents.find((i) => i.id === incidentId);
    if (!incident) return;

    const choice = incident.choices.find((c) => c.id === choiceId);
    if (!choice) return;

    // Apply telemetry updates
    setTelemetry((prev) => ({
      ...prev,
      ...choice.telemetryDelta,
    }));

    // Mark incident resolved
    setIncidents((prev) =>
      prev.map((inc) =>
        inc.id === incidentId
          ? {
              ...inc,
              resolved: true,
              resolvedBy: activeRoleDefinition.callsign,
              chosenOption: choice.label,
            }
          : inc
      )
    );

    // Append to logs
    const nowTime = new Date().toTimeString().slice(0, 8);
    const newLog: LogEntry = {
      id: Date.now().toString(),
      timestamp: nowTime,
      callsign: activeRoleDefinition.callsign,
      role: currentRole,
      message: `ACTION EXECUTED: "${choice.label}". Outcome: ${choice.actionOutcome}`,
      type: 'ACTION',
    };
    setLogs((prev) => [...prev, newLog]);
  };

  // Inject a new simulated space weather event
  const handleInjectAnomaly = () => {
    const anomalyTemplates: MissionIncident[] = [
      {
        id: `INC-${Date.now()}`,
        title: 'NeoWs High-Velocity Asteroid Close Proximity Alert',
        severity: 'CRITICAL',
        sourceDataset: 'NASA NeoWs Orbital Telemetry (Asteroid 2026-SP1)',
        timestamp: new Date().toTimeString().slice(0, 8),
        description:
          'Automated radar detects uncataloged debris fragment on near-conjunction vector. Course deviation required to guarantee vehicle perimeter safety clearance.',
        telemetryImpact: {
          trajectoryVariance: 38.5,
          shieldIntegrity: 68,
        },
        choices: [
          {
            id: 'CHOICE_FLIGHT_BURN',
            label: 'Authorize RCS Evasion Burn (Delta-V: 12 m/s)',
            requiredRole: 'FLIGHT_DIRECTOR',
            actionOutcome: 'Commands thruster firing vector to shift trajectory clear of the conjunction cone.',
            telemetryDelta: { trajectoryVariance: 0.1, shieldIntegrity: 98 },
          },
          {
            id: 'CHOICE_SCIENCE_SCAN',
            label: 'Execute High-Frequency Doppler Radar Precision Fix',
            requiredRole: 'SCIENCE_OFFICER',
            actionOutcome: 'Calculates exact asteroid trajectory, refining evasion burn parameters.',
            telemetryDelta: { trajectoryVariance: 4.2 },
          },
          {
            id: 'CHOICE_CAPCOM_BRACE',
            label: 'Order Astronaut Crew to Accelerate Impact Bracing',
            requiredRole: 'CAPCOM',
            actionOutcome: 'Transmits emergency checklist to astronauts in orbital module.',
            telemetryDelta: { shieldIntegrity: 90 },
          },
          {
            id: 'CHOICE_EECOM_THRUSTERS',
            label: 'Preheat Hypergolic Propellant Manifolds',
            requiredRole: 'EECOM',
            actionOutcome: 'Ensures reaction control engines fire instantaneously with maximum thrust.',
            telemetryDelta: { trajectoryVariance: 1.0 },
          },
        ],
        resolved: false,
      },
    ];

    const newAnomaly = anomalyTemplates[0];
    setIncidents((prev) => [newAnomaly, ...prev]);

    // Apply initial negative impact
    setTelemetry((prev) => ({
      ...prev,
      ...newAnomaly.telemetryImpact,
    }));

    // Add log
    setLogs((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        timestamp: new Date().toTimeString().slice(0, 8),
        callsign: 'MOCR ALARM',
        role: 'FLIGHT_DIRECTOR',
        message: `MASTER ALARM TRIGGERED: ${newAnomaly.title} (${newAnomaly.sourceDataset})`,
        type: 'ALARM',
      },
    ]);
  };

  // Transmit radio chatter
  const handleSendComms = (message: string) => {
    const nowTime = new Date().toTimeString().slice(0, 8);
    const newLog: LogEntry = {
      id: Date.now().toString(),
      timestamp: nowTime,
      callsign: activeRoleDefinition.callsign,
      role: currentRole,
      message,
      type: 'COMMS',
    };
    setLogs((prev) => [...prev, newLog]);
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  // Highest severity
  const activeUnresolved = incidents.filter((i) => !i.resolved);
  const highestSeverity = activeUnresolved.some((i) => i.severity === 'CRITICAL')
    ? 'CRITICAL'
    : activeUnresolved.some((i) => i.severity === 'WARNING')
    ? 'WARNING'
    : 'NOMINAL';

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans">
      <Header
        highestSeverity={highestSeverity}
        activeRoleTitle={`${activeRoleDefinition.title} (${activeRoleDefinition.callsign})`}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-8 space-y-6">
        {/* Role Selection Console */}
        <RoleSelector currentRole={currentRole} onSelectRole={setCurrentRole} />

        {/* Live Telemetry Display */}
        <TelemetryDisplay telemetry={telemetry} />

        {/* Roleplay Incidents & Anomaly Resolution Engine */}
        <IncidentConsole
          incidents={incidents}
          currentRole={currentRole}
          onResolveIncident={handleResolveIncident}
          onInjectSimulatedAnomaly={handleInjectAnomaly}
        />

        {/* NASA Data Ingestion & Mission Communications Log */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <NasaDataHub apod={apod} asteroids={asteroids} isLoading={isLoadingNasa} />
          <MissionLog
            logs={logs}
            currentRole={currentRole}
            roleCallsign={activeRoleDefinition.callsign}
            onSendComms={handleSendComms}
            onClearLogs={handleClearLogs}
          />
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 px-4 text-center text-xs text-slate-500 font-mono">
        <p className="max-w-2xl mx-auto mb-2">
          <strong>Code2Larp</strong> — NASA Space Apps Challenge 2026. Built by Adrian Xavier Moral (<a href="https://github.com/venstqs" className="text-cyan-400 hover:underline">@venstqs</a>).
        </p>
        <p className="text-[10px] text-slate-600">
          Powered by React 18, TypeScript, Tailwind CSS, and NASA Open Science Data APIs.
        </p>
      </footer>
    </div>
  );
};

export default App;
