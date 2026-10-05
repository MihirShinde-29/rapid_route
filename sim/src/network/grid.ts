import { Network } from './network';

export interface GridOptions {
  cols: number; // intersections per row
  rows: number;
  spacing: number; // m between intersections
  arterialEvery: number; // every Nth row/column is an arterial
  localSpeed: number; // m/s
  arterialSpeed: number; // m/s
}

export const DEFAULT_GRID: GridOptions = {
  cols: 13,
  rows: 9,
  spacing: 100,
  arterialEvery: 4,
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
  const { cols, rows, spacing, arterialEvery } = opts;
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
      if (c < cols - 1) addStreet(nodeAt(r, c), nodeAt(r, c + 1), r % arterialEvery === 0);
      if (r < rows - 1) addStreet(nodeAt(r, c), nodeAt(r + 1, c), c % arterialEvery === 0);
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
