import React from 'react';
import { Shield, Radio, Zap, Compass, CheckCircle2 } from 'lucide-react';
import { RoleType, RoleDefinition } from '../types/mission';

export const ROLES: RoleDefinition[] = [
  {
    id: 'FLIGHT_DIRECTOR',
    title: 'Flight Director',
    callsign: 'FLIGHT',
    badgeColor: 'border-amber-500/50 bg-amber-950/20 text-amber-300',
    description: 'Ultimate operational authority. Manages station go/no-go calls and coordinates emergency response teams.',
    primaryResponsibilities: [
      'Orchestrates team responses to critical anomalies',
      'Approves high-impact trajectory adjustments',
      'Manages mission priority queues',
    ],
    authorizedActions: ['Issue Station Go/No-Go', 'Override Safety Protocols', 'Authorize Orbital Burns'],
  },
  {
    id: 'CAPCOM',
    title: 'Capsule Communicator',
    callsign: 'CAPCOM',
    badgeColor: 'border-cyan-500/50 bg-cyan-950/20 text-cyan-300',
    description: 'The sole voice to the astronaut crew. Translates complex telemetry and command instructions into clear aerospace directives.',
    primaryResponsibilities: [
      'Dispatches verified radio protocols to the spacecraft',
      'Confirms checklist execution by orbital crew',
      'Maintains comms cadence during signal degradation',
    ],
    authorizedActions: ['Relay Emergency Checklists', 'Request Crew Status Report', 'Re-establish S-Band Carrier'],
  },
  {
    id: 'EECOM',
    title: 'Electrical & Consumables (EECOM)',
    callsign: 'EECOM',
    badgeColor: 'border-emerald-500/50 bg-emerald-950/20 text-emerald-300',
    description: 'Monitors life support systems, atmospheric scrubbers, battery storage, and solar array generation.',
    primaryResponsibilities: [
      'Balances solar panel orientation and battery draw',
      'Maintains cabin pressure and oxygen concentration',
      'Controls thermal radiators and shielding fields',
    ],
    authorizedActions: ['Cross-Tie Bus Breakers', 'Vent Cabin Nitrogen', 'Orient Solar Gimbals'],
  },
  {
    id: 'SCIENCE_OFFICER',
    title: 'Science & Sensor Specialist',
    callsign: 'SCIENCE',
    badgeColor: 'border-purple-500/50 bg-purple-950/20 text-purple-300',
    description: 'Analyzes real NASA astrophysical datasets, solar wind particle counts, and asteroid proximity trajectories.',
    primaryResponsibilities: [
      'Monitors real-time DONKI solar particle alerts',
      'Tracks NeoWs hazardous asteroid close approaches',
      'Calculates radiation absorption shielding indices',
    ],
    authorizedActions: ['Execute Radar Deep Scan', 'Deploy Magnetometer Array', 'Calibrate Spectrometer'],
  },
];

interface RoleSelectorProps {
  currentRole: RoleType;
  onSelectRole: (role: RoleType) => void;
}

export const RoleSelector: React.FC<RoleSelectorProps> = ({ currentRole, onSelectRole }) => {
  const getIcon = (roleId: RoleType) => {
    switch (roleId) {
      case 'FLIGHT_DIRECTOR':
        return <Shield className="w-5 h-5 text-amber-400" />;
      case 'CAPCOM':
        return <Radio className="w-5 h-5 text-cyan-400" />;
      case 'EECOM':
        return <Zap className="w-5 h-5 text-emerald-400" />;
      case 'SCIENCE_OFFICER':
        return <Compass className="w-5 h-5 text-purple-400" />;
    }
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 lg:p-6 shadow-xl backdrop-blur-md">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
        <div>
          <h2 className="text-sm uppercase font-mono tracking-wider text-slate-300 font-bold flex items-center gap-2">
            <span>🎭</span> Select Your Mission Role (LARP Station)
          </h2>
          <p className="text-xs text-slate-400">
            Each role grants unique command privileges, telemetry feeds, and decision capabilities.
          </p>
        </div>
        <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-slate-800 text-slate-300 border border-slate-700 w-fit">
          Synchronized Mission Control
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {ROLES.map((role) => {
          const isSelected = currentRole === role.id;
          return (
            <button
              key={role.id}
              onClick={() => onSelectRole(role.id)}
              className={`text-left p-4 rounded-lg border transition-all duration-200 flex flex-col justify-between ${
                isSelected
                  ? 'border-cyan-400 bg-slate-800/90 shadow-md shadow-cyan-500/10 ring-1 ring-cyan-400/50'
                  : 'border-slate-800 bg-slate-950/60 hover:border-slate-700 hover:bg-slate-900/60'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="p-2 rounded bg-slate-900 border border-slate-800">
                    {getIcon(role.id)}
                  </div>
                  <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${role.badgeColor}`}>
                    {role.callsign}
                  </span>
                </div>

                <h3 className="text-sm font-semibold text-white mb-1">
                  {role.title}
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-3">
                  {role.description}
                </p>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
                <span className="text-[11px] text-slate-500 font-mono">
                  {role.authorizedActions.length} Actions
                </span>
                {isSelected ? (
                  <span className="flex items-center gap-1 text-cyan-400 font-mono font-bold text-[11px]">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    OCCUPIED
                  </span>
                ) : (
                  <span className="text-slate-500 hover:text-slate-300 font-mono text-[11px]">
                    Claim Seat →
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
