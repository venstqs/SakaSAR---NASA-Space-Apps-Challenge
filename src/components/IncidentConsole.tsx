import React from 'react';
import { AlertTriangle, CheckCircle, ShieldAlert, Zap, ArrowRight, UserCheck } from 'lucide-react';
import { MissionIncident, RoleType } from '../types/mission';

interface IncidentConsoleProps {
  incidents: MissionIncident[];
  currentRole: RoleType;
  onResolveIncident: (incidentId: string, choiceId: string) => void;
  onInjectSimulatedAnomaly: () => void;
}

export const IncidentConsole: React.FC<IncidentConsoleProps> = ({
  incidents,
  currentRole,
  onResolveIncident,
  onInjectSimulatedAnomaly,
}) => {
  const unresolvedIncidents = incidents.filter((i) => !i.resolved);
  const resolvedIncidents = incidents.filter((i) => i.resolved);

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 lg:p-6 shadow-xl backdrop-blur-md">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
        <div>
          <h2 className="text-sm uppercase font-mono tracking-wider text-slate-300 font-bold flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-red-400" />
            Active Anomalies & Roleplay Incident Engine
          </h2>
          <p className="text-xs text-slate-400">
            Real astrophysical events require coordinated crew interventions. Only authorized roles can execute commands.
          </p>
        </div>

        <button
          onClick={onInjectSimulatedAnomaly}
          className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-red-600 to-amber-600 hover:from-red-500 hover:to-amber-500 text-white text-xs font-mono font-bold transition flex items-center gap-1.5 shadow-md shadow-red-900/30 w-fit"
        >
          <Zap className="w-3.5 h-3.5" />
          Inject Space Weather Anomaly
        </button>
      </div>

      {unresolvedIncidents.length === 0 ? (
        <div className="p-8 text-center rounded-lg bg-slate-950/40 border border-slate-800/80">
          <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2 opacity-80" />
          <h3 className="text-sm font-semibold text-white mb-1">No Active Flight Anomalies</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Spacecraft telemetry is operating within nominal safety margins. You can inject a simulated NASA space weather anomaly to test your team's roleplay responsiveness.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {unresolvedIncidents.map((incident) => {
            const isCritical = incident.severity === 'CRITICAL';
            return (
              <div
                key={incident.id}
                className={`p-4 rounded-lg border transition-all ${
                  isCritical
                    ? 'border-red-500/80 bg-red-950/20 shadow-lg shadow-red-950/40'
                    : 'border-amber-500/80 bg-amber-950/20'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                        isCritical
                          ? 'border-red-500 bg-red-900/60 text-red-300'
                          : 'border-amber-500 bg-amber-900/60 text-amber-300'
                      }`}
                    >
                      {incident.severity}
                    </span>
                    <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-red-400" />
                      {incident.title}
                    </h3>
                  </div>
                  <span className="text-[11px] font-mono text-cyan-300 bg-cyan-950/50 px-2 py-0.5 rounded border border-cyan-800/60">
                    Source: {incident.sourceDataset}
                  </span>
                </div>

                <p className="text-xs text-slate-300 mb-4 leading-relaxed">
                  {incident.description}
                </p>

                {/* Role Decision Options */}
                <div>
                  <h4 className="text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                    <UserCheck className="w-3.5 h-3.5 text-cyan-400" />
                    Available Roleplay Action Vectors:
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {incident.choices.map((choice) => {
                      const isRoleAuthorized = currentRole === choice.requiredRole;

                      return (
                        <button
                          key={choice.id}
                          disabled={!isRoleAuthorized}
                          onClick={() => onResolveIncident(incident.id, choice.id)}
                          className={`text-left p-3 rounded-lg border text-xs transition flex flex-col justify-between ${
                            isRoleAuthorized
                              ? 'border-cyan-500/80 bg-slate-800/90 hover:bg-slate-700/90 text-white cursor-pointer hover:shadow-md'
                              : 'border-slate-800 bg-slate-950/40 text-slate-500 opacity-60 cursor-not-allowed'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-bold text-slate-200">
                                {choice.label}
                              </span>
                              <span
                                className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                                  isRoleAuthorized
                                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                                    : 'bg-slate-900 text-slate-600 border border-slate-800'
                                }`}
                              >
                                Req: {choice.requiredRole.replace('_', ' ')}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400">
                              Outcome: {choice.actionOutcome}
                            </p>
                          </div>

                          <div className="mt-2 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[10px] font-mono">
                            {isRoleAuthorized ? (
                              <span className="text-cyan-400 font-bold flex items-center gap-1">
                                Execute Command Vector <ArrowRight className="w-3 h-3" />
                              </span>
                            ) : (
                              <span className="text-slate-600">
                                Switch to {choice.requiredRole} to authorize
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Resolved History Counter */}
      {resolvedIncidents.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400 font-mono">
          <span>Resolved Anomalies in Session: {resolvedIncidents.length}</span>
          <span className="text-emerald-400 flex items-center gap-1">
            <CheckCircle className="w-3.5 h-3.5" />
            Crew Resource Protocol Active
          </span>
        </div>
      )}
    </div>
  );
};
