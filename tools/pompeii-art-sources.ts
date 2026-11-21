// The Commons files the Pompeii art atlas is restored from, and the fetch
// width. tools/fetch-pompeii-art.ts downloads them and checks each licence;
// tools/bake-pompeii-art.ts says which part of each photograph becomes which
// panel and where it hangs.

export interface ArtSource {
  id: string;
  /** Commons file title. */
  file: string;
  /** Thumbnail width to fetch; the default is 1920 px; only the standard steps (960, 1280, 1920, 3840) are served. */
  w?: number;
}

export const ART_SOURCES: ArtSource[] = [
  { id: "misteri-frieze", file: "File:Villa Misteri fresco mystery ritual.jpg", w: 3840 },
  { id: "misteri-north", file: "File:Villa of the Mysteries (Pompeii) - Hall of the Mysteries (North wall).jpg" },
  { id: "misteri-east", file: "File:Villa of the Mysteries (Pompeii) - Hall of the Mysteries (East wall).jpg" },
  { id: "vettii-ixion", file: "File:Pompeii - Casa dei Vettii - Ixion.jpg" },
  { id: "vettii-ixion-wall", file: "File:Casa dei vettii, vestibolo, oechus affrescato sul peristilio, issione legato alla ruota da vulcano alla presenza di giunone 01.jpg" },
  { id: "vettii-cupids-race", file: "File:Pompeii- Domus Vettiorum, Chariot Lovers' Race, triclinium decoration, No. 11241 (SM stf1545).png" },
  { id: "vettii-cupids-money", file: "File:Pompeii- Domus Vettiorum, Money lovers, triclinium decoration, No. 11239 (SM stf1544).png" },
  { id: "vettii-fresco", file: "File:Pompeii Fresco, House of Vetti (9809390525).jpg" },
  { id: "vettii-a", file: "File:House of the Vettii - Pompeii Scavi (54537851380).jpg" },
  { id: "vettii-b", file: "File:House of the Vettii - Pompeii Scavi (54537851870).jpg" },
  { id: "vettii-c", file: "File:House of the Vettii - Pompeii Scavi (54537731063).jpg" },
  { id: "vettii-d", file: "File:House of the Vettii - Pompeii Scavi (54537677554).jpg" },
  { id: "vettii-wlm", file: "File:Casa dei Vettii WLM24 (79).jpg" },
  { id: "alexander", file: "File:The Alexander Mosaic.jpg" },
  { id: "alexander-bw", file: "File:Battle of Issus mosaic - Museo Archeologico Nazionale - Naples 2013-05-16 16-25-06 BW.jpg" },
  { id: "cave-canem", file: "File:Cave canem mosaic (Pompeii).jpg" },
  { id: "cave-canem-b", file: "File:Pompeii - Cave Canem (4786638740).jpg" },
  { id: "paquius-dog", file: "File:Cave Cavem mosaic floor from the House of Paquio Procolo, Pompeii (14585425031).jpg" },
  { id: "faun-have", file: "File:HAVE - House in Pompeii.jpg" },
  { id: "venus-shell", file: "File:Fresco of Venus in a Shell (49345513807).jpg" },
  { id: "garden-room-1", file: "File:Pompeii - Casa del Bracciale d'Oro - Garden Room 1.jpg" },
  { id: "garden-room-2", file: "File:Pompeii - Casa del Bracciale d'Oro - Garden Room 2.jpg" },
  { id: "black-wall", file: "File:Casa della Parete Nera 1.JPG" },
  { id: "bronzi-fourth", file: "File:Fourth style frescoed wall with reds and greens in the Casa dei Bronzi Pompeii by Wilhelm Zahn.jpg" },
  { id: "centauro-scheme", file: "File:Wall pattern from the Casa del Centauro in Pompeii excavated in 1829 by Wilhelm Zahn.jpg" },
  { id: "vestali-wall", file: "File:Frescoed wall from the Casa delle Vestali in Pompeii by Wilhelm Zahn.jpg" },
  { id: "seascape-black", file: "File:Wall painting - seascape on black ground - Pompeii (VII 1 7) - Napoli MAN 9482.jpg" },
  { id: "maenads", file: "File:Wall painting - dancing maenads - Pompeii (villa of Cicero) - Napoli MAN 9297 - 01.jpg", w: 3840 },
  { id: "bazzani-fourth", file: "File:Architectural fresco with mural in Pompeii watercolor by Luigi Bazzani.jpg" },
];
