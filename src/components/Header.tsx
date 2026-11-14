import React, { useEffect, useState } from 'react';
import { Radio, AlertTriangle, ShieldCheck, Activity, Globe } from 'lucide-react';
import { IncidentSeverity } from '../types/mission';

interface HeaderProps {
  highestSeverity: IncidentSeverity;
  activeRoleTitle: string;
}

export const Header: React.FC<HeaderProps> = ({ highestSeverity, activeRoleTitle }) => {
  const [utcTime, setUtcTime] = useState<string>('');

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setUtcTime(now.toUTCString().replace('GMT', 'UTC'));
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  const getAlarmBadge = () => {
    switch (highestSeverity) {
      case 'CRITICAL':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded bg-red-950/80 border border-red-500 text-red-400 text-xs font-mono font-bold animate-pulse">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            MASTER ALARM: CRITICAL
          </span>
        );
      case 'WARNING':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded bg-amber-950/80 border border-amber-500 text-amber-400 text-xs font-mono font-bold">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            ALARM: WARNING STATE
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-950/70 border border-emerald-500 text-emerald-400 text-xs font-mono">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            ALL STATIONS NOMINAL
          </span>
        );
    }
  };

  return (
    <header className="border-b border-slate-800 bg-slate-950/90 backdrop-blur-md sticky top-0 z-50 px-4 lg:px-8 py-3">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        
        {/* Brand & Mission Title */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-tr from-blue-700 via-indigo-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Activity className="w-5 h-5 text-white animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-wider text-white uppercase font-mono">
                Code2Larp
              </h1>
              <span className="text-[10px] px-2 py-0.5 rounded font-mono font-bold bg-blue-900/60 text-blue-300 border border-blue-700">
                NASA SPACE APPS 2026
              </span>
            </div>
            <p className="text-xs text-slate-400 flex items-center gap-1.5">
              <span>Flight Operations Control</span>
              <span className="text-slate-600">•</span>
              <span className="text-cyan-400 font-mono font-semibold">Seat: {activeRoleTitle}</span>
            </p>
          </div>
        </div>

        {/* Mission Telemetry Indicators & Time */}
        <div className="flex flex-wrap items-center justify-center md:justify-end gap-3">
          {getAlarmBadge()}

          <div className="flex items-center gap-2 px-3 py-1 rounded bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300">
            <Globe className="w-3.5 h-3.5 text-cyan-400" />
            <span>{utcTime || 'SYNCING UTC CLOCK...'}</span>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1 rounded bg-slate-900 border border-slate-800 text-xs font-mono text-slate-400">
            <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span>MOCR LINK: <strong className="text-emerald-400">ONLINE</strong></span>
          </div>
        </div>

      </div>
    </header>
  );
};
