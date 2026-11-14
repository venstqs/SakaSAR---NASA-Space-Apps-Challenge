import React from 'react';
import { Sun, Wind, Shield, AlertOctagon, Orbit, Gauge, Zap } from 'lucide-react';
import { TelemetryData } from '../types/mission';

interface TelemetryDisplayProps {
  telemetry: TelemetryData;
}

export const TelemetryDisplay: React.FC<TelemetryDisplayProps> = ({ telemetry }) => {
  // Status evaluation helpers
  const getPowerStatus = (val: number) => {
    if (val < 40) return { label: 'CRITICAL', color: 'text-red-400', bar: 'bg-red-500' };
    if (val < 70) return { label: 'DEGRADED', color: 'text-amber-400', bar: 'bg-amber-500' };
    return { label: 'NOMINAL', color: 'text-emerald-400', bar: 'bg-emerald-500' };
  };

  const getShieldStatus = (val: number) => {
    if (val < 35) return { label: 'BREACH WARNING', color: 'text-red-400', bar: 'bg-red-500' };
    if (val < 75) return { label: 'COMPROMISED', color: 'text-amber-400', bar: 'bg-amber-500' };
    return { label: 'MAXIMUM', color: 'text-emerald-400', bar: 'bg-emerald-500' };
  };

  const getRadiationStatus = (val: number) => {
    if (val > 100) return { label: 'LETHAL SPIKE', color: 'text-red-400', bar: 'bg-red-500' };
    if (val > 45) return { label: 'ELEVATED (CME)', color: 'text-amber-400', bar: 'bg-amber-500' };
    return { label: 'NOMINAL (QUIET)', color: 'text-emerald-400', bar: 'bg-emerald-500' };
  };

  const power = getPowerStatus(telemetry.solarArrayOutput);
  const shield = getShieldStatus(telemetry.shieldIntegrity);
  const radiation = getRadiationStatus(telemetry.radiationDoseRate);

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 lg:p-6 shadow-xl backdrop-blur-md">
      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
        <div>
          <h2 className="text-sm uppercase font-mono tracking-wider text-slate-300 font-bold flex items-center gap-2">
            <Gauge className="w-4 h-4 text-cyan-400" />
            Live Spacecraft Telemetry (Orbital Module)
          </h2>
          <p className="text-xs text-slate-400">
            Real-time environmental and propulsion telemetry synced with active flight computers.
          </p>
        </div>
        <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-500/50 text-emerald-400 animate-pulse">
          S-BAND DOWNLINK: 100%
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        
        {/* Solar Array Power */}
        <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-400 flex items-center gap-1.5 font-mono">
              <Sun className="w-3.5 h-3.5 text-amber-400" />
              SOLAR ARRAY OUTPUT
            </span>
            <span className={`text-[10px] font-mono font-bold ${power.color}`}>
              {power.label}
            </span>
          </div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-2xl font-bold font-mono text-white">
              {telemetry.solarArrayOutput}%
            </span>
            <span className="text-xs text-slate-500 font-mono">Rating: 12.4 kW</span>
          </div>
          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${power.bar}`}
              style={{ width: `${Math.min(100, Math.max(0, telemetry.solarArrayOutput))}%` }}
            />
          </div>
        </div>

        {/* Radiation Level */}
        <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-400 flex items-center gap-1.5 font-mono">
              <AlertOctagon className="w-3.5 h-3.5 text-red-400" />
              RADIATION DOSIMETER
            </span>
            <span className={`text-[10px] font-mono font-bold ${radiation.color}`}>
              {radiation.label}
            </span>
          </div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-2xl font-bold font-mono text-white">
              {telemetry.radiationDoseRate}
              <span className="text-xs text-slate-400 ml-1 font-normal">µSv/h</span>
            </span>
            <span className="text-xs text-slate-500 font-mono">Baseline: 18 µSv/h</span>
          </div>
          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${radiation.bar}`}
              style={{ width: `${Math.min(100, (telemetry.radiationDoseRate / 150) * 100)}%` }}
            />
          </div>
        </div>

        {/* Shield Integrity */}
        <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-400 flex items-center gap-1.5 font-mono">
              <Shield className="w-3.5 h-3.5 text-cyan-400" />
              MICROMETEORITE SHIELD
            </span>
            <span className={`text-[10px] font-mono font-bold ${shield.color}`}>
              {shield.label}
            </span>
          </div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-2xl font-bold font-mono text-white">
              {telemetry.shieldIntegrity}%
            </span>
            <span className="text-xs text-slate-500 font-mono">Deflection: Active</span>
          </div>
          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${shield.bar}`}
              style={{ width: `${Math.min(100, Math.max(0, telemetry.shieldIntegrity))}%` }}
            />
          </div>
        </div>

        {/* Cabin Atmosphere */}
        <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-400 flex items-center gap-1.5 font-mono">
              <Wind className="w-3.5 h-3.5 text-blue-400" />
              CABIN PRESSURE & O₂
            </span>
            <span className="text-[10px] font-mono text-emerald-400 font-bold">STABLE</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-xl font-bold font-mono text-white">
              {telemetry.cabinPressure.toFixed(1)} <span className="text-xs text-slate-400">kPa</span>
            </span>
            <span className="text-sm font-mono text-cyan-300">
              O₂: {telemetry.oxygenLevel.toFixed(1)}%
            </span>
          </div>
          <p className="text-[11px] text-slate-500 font-mono mt-2">
            Scrubbers operating in closed-loop recycling
          </p>
        </div>

        {/* Trajectory Off-Nominal Variance */}
        <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-400 flex items-center gap-1.5 font-mono">
              <Orbit className="w-3.5 h-3.5 text-indigo-400" />
              TRAJECTORY VARIANCE
            </span>
            <span className={`text-[10px] font-mono font-bold ${
              Math.abs(telemetry.trajectoryVariance) > 15 ? 'text-amber-400' : 'text-emerald-400'
            }`}>
              {Math.abs(telemetry.trajectoryVariance) > 15 ? 'DRIFT ALERT' : 'ON TRACK'}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-xl font-bold font-mono text-white">
              {telemetry.trajectoryVariance > 0 ? `+${telemetry.trajectoryVariance}` : telemetry.trajectoryVariance}
              <span className="text-xs text-slate-400 ml-1">km</span>
            </span>
            <span className="text-xs text-slate-500 font-mono">
              Vel: {telemetry.velocityKmS.toFixed(2)} km/s
            </span>
          </div>
          <p className="text-[11px] text-slate-500 font-mono mt-2">
            Target: Translunar Injection Vector
          </p>
        </div>

        {/* Mission Distance */}
        <div className="p-3.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-400 flex items-center gap-1.5 font-mono">
              <Zap className="w-3.5 h-3.5 text-yellow-400" />
              EARTH DISTANCE & COMM LAG
            </span>
            <span className="text-[10px] font-mono text-cyan-400 font-bold">DSN LOCKED</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-xl font-bold font-mono text-white">
              {telemetry.distanceFromEarthKm.toLocaleString()}
              <span className="text-xs text-slate-400 ml-1">km</span>
            </span>
            <span className="text-xs text-slate-400 font-mono">Lag: 1.28 sec</span>
          </div>
          <p className="text-[11px] text-slate-500 font-mono mt-2">
            Deep Space Network Goldstone Station
          </p>
        </div>

      </div>
    </div>
  );
};
