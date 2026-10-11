import type { Network } from '../network/network';

// Fixed-time traffic signals. Every junction where an arterial meets two or more other
// approaches, and every downtown junction, gets a two-phase plan: green, yellow and all-red
// for one axis, then the other. Other junctions of local streets are all-way stops.

export type Light = 'green' | 'yellow' | 'red';

export const SIGNAL_TIMING = {
  arterialGreen: 32, // s, arterial axis where it crosses a local street
  localGreen: 18, // s, local axis at the same junction
  evenGreen: 25, // s, each axis where two arterials or two downtown streets cross
  yellow: 3,
  allRed: 2,
  waveSpeed: 14, // m/s; offsets give a green wave to traffic heading east or south at this speed
};

interface Plan {
  firstEW: boolean; // which axis goes first in the cycle
  green: [number, number]; // first phase, second phase
  offset: number;
  cycle: number;
}

const ewAxis = (net: Network, linkId: number): boolean => {
  const l = net.links[linkId];
  const a = net.nodes[l.from];
  const b = net.nodes[l.to];
  return Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
};

export class SignalPlans {
  private plans: (Plan | null)[];

  // downtown: junctions signalised even where two local streets cross.
  constructor(
    private net: Network,
    downtown: (node: number) => boolean = () => false,
  ) {
    const T = SIGNAL_TIMING;
    this.plans = net.nodes.map((node, id) => {
      const ins = net.inLinks[id];
      if (ins.length < 3) return null;
      const artEW = ins.some((l) => net.links[l].arterial && ewAxis(net, l));
      const artNS = ins.some((l) => net.links[l].arterial && !ewAxis(net, l));
      const local = !artEW && !artNS;
      if (local && !downtown(id)) return null;
      const even = local || (artEW && artNS);
      const green: [number, number] = even ? [T.evenGreen, T.evenGreen] : [T.arterialGreen, T.localGreen];
      const cycle = green[0] + green[1] + 2 * (T.yellow + T.allRed);
      return { firstEW: even || artEW, green, offset: (node.x + node.y) / T.waveSpeed, cycle };
    });
  }

  isSignalised(node: number): boolean {
    return this.plans[node] !== null;
  }

  // Light shown to traffic on an approach link at time t, or null at an unsignalised junction.
  light(inLink: number, t: number): Light | null {
    const plan = this.plans[this.net.links[inLink].to];
    if (!plan) return null;
    const T = SIGNAL_TIMING;
    const u = (((t - plan.offset) % plan.cycle) + plan.cycle) % plan.cycle;
    const first = ewAxis(this.net, inLink) === plan.firstEW;
    const start = first ? 0 : plan.green[0] + T.yellow + T.allRed;
    const g = first ? plan.green[0] : plan.green[1];
    const s = u - start;
    if (s >= 0 && s < g) return 'green';
    if (s >= g && s < g + T.yellow) return 'yellow';
    return 'red';
  }

  // Seconds until the light on this approach turns red (0 if it is red).
  timeLeft(inLink: number, t: number): number {
    const plan = this.plans[this.net.links[inLink].to];
    if (!plan) return Infinity;
    const T = SIGNAL_TIMING;
    const u = (((t - plan.offset) % plan.cycle) + plan.cycle) % plan.cycle;
    const first = ewAxis(this.net, inLink) === plan.firstEW;
    const start = first ? 0 : plan.green[0] + T.yellow + T.allRed;
    const s = u - start;
    const end = (first ? plan.green[0] : plan.green[1]) + T.yellow;
    return s >= 0 && s < end ? end - s : 0;
  }
}
