import { Network } from './network';

export interface GridOptions {
  cols: number; // intersections per row
  rows: number;
  spacing: number; // m between intersections
  arterialEvery: number; // every Nth row/column is an arterial
  suburbRing: number; // blocks of low-density suburb around the city core
  localSpeed: number; // m/s
  arterialSpeed: number; // m/s
}

export const DEFAULT_GRID: GridOptions = {
  cols: 27, // 16x12-block core plus 5 blocks of suburb on each side
  rows: 23,
  spacing: 100,
  arterialEvery: 4,
  suburbRing: 5,
  localSpeed: 11, // ~40 km/h
  arterialSpeed: 17, // ~60 km/h
};

// A block is the cell between four intersections; zones live on blocks.
export interface Block {
  r: number;
  c: number;
  corners: [number, number, number, number]; // TL, TR, BR, BL node ids
}

export interface Grid {
  net: Network;
  opts: GridOptions;
  nodeAt(r: number, c: number): number;
  blocks: Block[];
  width: number;
  height: number;
}

export function buildGrid(opts: GridOptions = DEFAULT_GRID): Grid {
  const { cols, rows, spacing, arterialEvery, suburbRing } = opts;
  // Arterials are counted from the core's edge so the core keeps its layout.
  const isArterial = (k: number) => (((k - suburbRing) % arterialEvery) + arterialEvery) % arterialEvery === 0;
  const net = new Network();
  const nodeAt = (r: number, c: number) => r * cols + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) net.addNode(c * spacing, r * spacing);
  }

  const addStreet = (a: number, b: number, arterial: boolean) => {
    const lanes = arterial ? 2 : 1;
    const speed = arterial ? opts.arterialSpeed : opts.localSpeed;
    net.addLink(a, b, lanes, speed, arterial);
    net.addLink(b, a, lanes, speed, arterial);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c < cols - 1) addStreet(nodeAt(r, c), nodeAt(r, c + 1), isArterial(r));
      if (r < rows - 1) addStreet(nodeAt(r, c), nodeAt(r + 1, c), isArterial(c));
    }
  }

  const blocks: Block[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      blocks.push({
        r,
        c,
        corners: [nodeAt(r, c), nodeAt(r, c + 1), nodeAt(r + 1, c + 1), nodeAt(r + 1, c)],
      });
    }
  }

  return { net, opts, nodeAt, blocks, width: (cols - 1) * spacing, height: (rows - 1) * spacing };
}
