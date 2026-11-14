import React from 'react';
import { Database, ExternalLink, Globe, AlertCircle, Sparkles } from 'lucide-react';
import { NasaApodData, NasaAsteroidAlert } from '../types/mission';

interface NasaDataHubProps {
  apod: NasaApodData | null;
  asteroids: NasaAsteroidAlert[];
  isLoading: boolean;
}

export const NasaDataHub: React.FC<NasaDataHubProps> = ({ apod, asteroids, isLoading }) => {
  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 lg:p-6 shadow-xl backdrop-blur-md">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
        <div>
          <h2 className="text-sm uppercase font-mono tracking-wider text-slate-300 font-bold flex items-center gap-2">
            <Database className="w-4 h-4 text-cyan-400" />
            NASA Open Data Telemetry Feed
          </h2>
          <p className="text-xs text-slate-400">
            Real astrophysics data ingested from official NASA endpoints into the simulation pipeline.
          </p>
        </div>

        <a
          href="https://api.nasa.gov/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-cyan-400 hover:text-cyan-300 flex items-center gap-1.5 transition underline-offset-4 hover:underline"
        >
          <span>NASA Open API Portal</span>
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        
        {/* APOD Imagery & Briefing */}
        <div className="p-4 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-mono text-cyan-400 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                NASA APOD SENSOR RECONNAISSANCE
              </span>
              <span className="text-[10px] font-mono text-slate-500">
                {apod?.date || 'LIVE FEED'}
              </span>
            </div>

            {apod?.url && (
              <div className="relative aspect-video rounded-md overflow-hidden mb-3 border border-slate-800 group">
                <img
                  src={apod.url}
                  alt={apod.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-transparent to-transparent pointer-events-none" />
                <span className="absolute bottom-2 left-2 text-xs font-semibold text-white drop-shadow-md">
                  {apod.title}
                </span>
              </div>
            )}

            <p className="text-xs text-slate-300 leading-relaxed line-clamp-3">
              {apod?.explanation || 'Loading scientific sensor calibration visual from NASA Deep Space Network...'}
            </p>
          </div>

          <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
            <span>NASA Planetary Astronomy Endpoint</span>
            <span className="text-emerald-400">VERIFIED FEED</span>
          </div>
        </div>

        {/* NeoWs Near Earth Asteroids Tracker */}
        <div className="p-4 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-mono text-cyan-400 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-cyan-400" />
                NASA NeoWs (NEAR-EARTH OBJECT RADAR)
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950/80 border border-blue-700 text-blue-300">
                RADAR LIVE
              </span>
            </div>

            {isLoading ? (
              <div className="py-8 text-center text-xs font-mono text-slate-500">
                Querying NASA NeoWs REST API...
              </div>
            ) : (
              <div className="space-y-2">
                {asteroids.map((ast) => (
                  <div
                    key={ast.id}
                    className="p-2.5 rounded bg-slate-900/90 border border-slate-800 flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-white">{ast.name}</span>
                        {ast.isPotentiallyHazardous && (
                          <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-red-950 text-red-400 border border-red-700 flex items-center gap-0.5">
                            <AlertCircle className="w-2.5 h-2.5" /> HAZARDOUS
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                        Est. Diameter: <strong className="text-slate-200">{ast.estimatedDiameterMeters}m</strong> | Miss Dist: {ast.missDistanceKm} km
                      </div>
                    </div>

                    <span className="text-[10px] font-mono text-slate-500 text-right whitespace-nowrap">
                      {ast.closeApproachDate.split(' ')[0]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
            <span>NASA Center for Near-Earth Object Studies (CNEOS)</span>
            <span className="text-cyan-400">SYNCED</span>
          </div>
        </div>

      </div>
    </div>
  );
};
