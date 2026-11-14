import { NasaApodData, NasaAsteroidAlert } from '../types/mission';

const NASA_API_BASE = 'https://api.nasa.gov';
const API_KEY = import.meta.env.VITE_NASA_API_KEY || 'DEMO_KEY';

/**
 * Fetch Astronomy Picture of the Day with offline/fallback telemetry
 */
export async function fetchNasaApod(): Promise<NasaApodData> {
  try {
    const res = await fetch(`${NASA_API_BASE}/planetary/apod?api_key=${API_KEY}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`NASA API returned status ${res.status}`);
    const data = await res.json();
    return {
      title: data.title || 'Deep Space Telemetry Reconnaissance',
      explanation: data.explanation || 'Mission visual feed captured via NASA Space Telescope network.',
      url: data.url || 'https://images-assets.nasa.gov/image/PIA14417/PIA14417~orig.jpg',
      date: data.date || new Date().toISOString().slice(0, 10),
    };
  } catch {
    // Fallback NASA data for offline or demo presentations
    return {
      title: 'Carina Nebula: Pillars of Creation (Recon Feed)',
      explanation: 'Deep infrared composite capturing turbulent stellar nursery clouds and cosmic dust columns. Used for navigation calibration and optical sensor alignment.',
      url: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80',
      date: '2026-11-14',
    };
  }
}

/**
 * Fetch Near Earth Asteroids with realistic simulation fallback
 */
export async function fetchNearEarthObjects(): Promise<NasaAsteroidAlert[]> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `${NASA_API_BASE}/neo/rest/v1/feed?start_date=${today}&end_date=${today}&api_key=${API_KEY}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) throw new Error(`NeoWs API failed: ${res.status}`);
    const data = await res.json();
    const nearEarthObjects = data.near_earth_objects?.[today] || [];

    return nearEarthObjects.slice(0, 4).map((neo: any) => ({
      id: neo.id,
      name: neo.name,
      estimatedDiameterMeters: Math.round(
        (neo.estimated_diameter?.meters?.estimated_diameter_max || 120)
      ),
      isPotentiallyHazardous: !!neo.is_potentially_hazardous_asteroid,
      closeApproachDate: neo.close_approach_data?.[0]?.close_approach_date_full || today,
      missDistanceKm: Math.round(
        parseFloat(neo.close_approach_data?.[0]?.miss_distance?.kilometers || '1500000')
      ).toLocaleString(),
    }));
  } catch {
    // Simulated realistic NASA NeoWs data stream
    return [
      {
        id: 'NEO-2026-SP1',
        name: 'Asteroid 2026 SP-1 (Apophis Sub-Cluster)',
        estimatedDiameterMeters: 340,
        isPotentiallyHazardous: true,
        closeApproachDate: '2026-11-14 14:22 UTC',
        missDistanceKm: '412,850',
      },
      {
        id: 'NEO-2024-XR8',
        name: '433 Eros Orbital Proximity',
        estimatedDiameterMeters: 16800,
        isPotentiallyHazardous: false,
        closeApproachDate: '2026-11-14 19:40 UTC',
        missDistanceKm: '22,410,000',
      },
      {
        id: 'NEO-2026-LM4',
        name: '2026 LM-4 (Trojan Asteroid)',
        estimatedDiameterMeters: 85,
        isPotentiallyHazardous: false,
        closeApproachDate: '2026-11-15 03:15 UTC',
        missDistanceKm: '1,890,200',
      },
    ];
  }
}
