/** The 22 approved landmarks (user, 2026-11-12; plan A section 4.2). `osm` ids are filled in from `discover`. */
export interface Landmark {
  slug: string;
  /** Descriptive player-facing name where the proper name is trade-marked or unlicensed (plan A 4.1). */
  title: string;
  lat: number;
  lon: number;
  /** Discovery radius in metres. */
  radius: number;
  /** Chosen OSM elements (`way/123`, `relation/456`). */
  osm: string[];
}

export const LANDMARKS: Landmark[] = [
  { slug: 'notre-dame', title: 'Gothic Cathedral of Paris', lat: 48.85296, lon: 2.34995, radius: 150, osm: ['way/201611261'] },
  { slug: 'eiffel-tower', title: 'Iron Lattice Tower', lat: 48.85837, lon: 2.29448, radius: 150, osm: ['way/5013364'] },
  { slug: 'arc-de-triomphe', title: 'Arc de Triomphe', lat: 48.87378, lon: 2.295, radius: 120, osm: ['way/226413508'] },
  { slug: 'sacre-coeur', title: 'Sacre-Coeur', lat: 48.8867, lon: 2.3431, radius: 150, osm: ['way/23762981'] },
  { slug: 'elizabeth-tower', title: 'Elizabeth Tower and Palace of Westminster (section)', lat: 51.5005, lon: -0.1248, radius: 250, osm: ['relation/1567699', 'way/123557148'] },
  { slug: 'tower-bridge', title: 'Tower Bridge', lat: 51.50554, lon: -0.07541, radius: 200, osm: ['way/367652787', 'way/367652791', 'way/378541210', 'way/367657974'] },
  { slug: 'st-pauls', title: "St Paul's Cathedral", lat: 51.51387, lon: -0.0984, radius: 150, osm: ['way/369161987'] },
  { slug: 'white-tower', title: 'The White Tower', lat: 51.50814, lon: -0.076, radius: 100, osm: ['way/369135772'] },
  { slug: 'statue-of-liberty', title: 'Statue of Liberty and pedestal', lat: 40.68925, lon: -74.0445, radius: 120, osm: ['way/32965412'] },
  { slug: 'us-capitol', title: 'United States Capitol', lat: 38.8899, lon: -77.0091, radius: 200, osm: ['way/66418809'] },
  { slug: 'independence-hall', title: 'Independence Hall', lat: 39.94887, lon: -75.15003, radius: 100, osm: ['way/25271595'] },
  { slug: 'lincoln-memorial', title: 'Lincoln Memorial', lat: 38.88929, lon: -77.05011, radius: 150, osm: ['way/398769543'] },
  { slug: 'washington-monument', title: 'Washington Monument', lat: 38.8895, lon: -77.0352, radius: 100, osm: ['way/766761337'] },
  { slug: 'brandenburg-gate', title: 'Brandenburg Gate', lat: 52.51628, lon: 13.3777, radius: 100, osm: ['way/518071791'] },
  { slug: 'cologne-cathedral', title: 'Cologne Cathedral', lat: 50.94133, lon: 6.95811, radius: 150, osm: ['way/4532022'] },
  { slug: 'neuschwanstein', title: 'Alpine Swan Castle', lat: 47.5576, lon: 10.7498, radius: 150, osm: ['way/221601969', 'way/221599090', 'way/221599087', 'way/221599096', 'way/223311650'] },
  { slug: 'st-basils', title: "St Basil's Cathedral", lat: 55.75253, lon: 37.6231, radius: 150, osm: ['relation/3030568'] },
  { slug: 'himeji-castle', title: 'Himeji Castle', lat: 34.8394, lon: 134.694, radius: 250, osm: ['way/23707900'] },
  { slug: 'taj-mahal', title: 'Taj Mahal', lat: 27.1751, lon: 78.04219, radius: 200, osm: ['way/375257537'] },
  { slug: 'hagia-sophia', title: 'Hagia Sophia', lat: 41.00863, lon: 28.98013, radius: 120, osm: ['way/109862851'] },
  { slug: 'temple-of-heaven-hall-of-prayer', title: 'Hall of Prayer for Good Harvests', lat: 39.8822, lon: 116.4066, radius: 150, osm: ['way/43921139'] },
  { slug: 'kinderdijk-windmill', title: 'Dutch Polder Windmill', lat: 51.883, lon: 4.64, radius: 400, osm: ['way/267410274'] },
];
