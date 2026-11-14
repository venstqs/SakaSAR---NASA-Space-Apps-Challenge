import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Send, Trash2 } from 'lucide-react';
import { LogEntry, RoleType } from '../types/mission';

interface MissionLogProps {
  logs: LogEntry[];
  currentRole: RoleType;
  roleCallsign: string;
  onSendComms: (message: string) => void;
  onClearLogs: () => void;
}

export const MissionLog: React.FC<MissionLogProps> = ({
  logs,
  currentRole: _currentRole,
  roleCallsign,
  onSendComms,
  onClearLogs,
}) => {
  const [inputText, setInputText] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendComms(inputText.trim());
    setInputText('');
  };

  const getTypeStyle = (type: LogEntry['type']) => {
    switch (type) {
      case 'ALARM':
        return 'text-red-400 bg-red-950/40 border-red-800';
      case 'ACTION':
        return 'text-cyan-400 bg-cyan-950/40 border-cyan-800';
      case 'TELEMETRY':
        return 'text-amber-400 bg-amber-950/40 border-amber-800';
      case 'COMMS':
      default:
        return 'text-emerald-400 bg-slate-900 border-slate-800';
    }
  };

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 lg:p-6 shadow-xl backdrop-blur-md flex flex-col h-[480px]">
      <div className="flex items-center justify-between gap-2 mb-3 pb-3 border-b border-slate-800">
        <div>
          <h2 className="text-sm uppercase font-mono tracking-wider text-slate-300 font-bold flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            Mission Operations Voice & Telemetry Log
          </h2>
          <p className="text-xs text-slate-400">
            Real-time transcript of flight director decisions, radio chatter, and telemetry alerts.
          </p>
        </div>

        <button
          onClick={onClearLogs}
          className="text-xs font-mono text-slate-500 hover:text-red-400 transition flex items-center gap-1 p-1"
          title="Clear Log Terminal"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Terminal Output */}
      <div
        ref={logContainerRef}
        className="flex-1 overflow-y-auto space-y-2 p-3 bg-slate-950 rounded-lg border border-slate-800/80 font-mono text-xs scroll-smooth"
      >
        {logs.length === 0 ? (
          <div className="text-slate-600 text-center py-12">
            -- MOCR FLIGHT LOG INITIALIZED --
          </div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className={`p-2 rounded border flex flex-col sm:flex-row sm:items-start justify-between gap-1 ${getTypeStyle(
                log.type
              )}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-slate-500 whitespace-nowrap mt-0.5">
                  [{log.timestamp}]
                </span>
                <span className="font-bold text-white whitespace-nowrap">
                  {log.callsign}:
                </span>
                <span className="text-slate-200 break-words leading-relaxed">
                  {log.message}
                </span>
              </div>
              <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.2 rounded bg-slate-950/80 text-slate-400 self-end sm:self-start border border-slate-800">
                {log.type}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Comms Transmitter Input */}
      <form onSubmit={handleSubmit} className="mt-3 flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono text-cyan-400 font-bold shrink-0">
          <span>TX:</span>
          <span>{roleCallsign}</span>
        </div>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={`Transmit operational comms as ${roleCallsign}... (e.g. "FLIGHT, EECOM reports solar bus stabilized.")`}
          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 transition"
        />
        <button
          type="submit"
          className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs font-mono flex items-center gap-1.5 transition shadow-md shadow-cyan-900/40"
        >
          <Send className="w-3.5 h-3.5" />
          Transmit
        </button>
      </form>
    </div>
  );
};
