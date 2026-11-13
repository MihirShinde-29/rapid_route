// First-shift tutorial (W12): a short card over the map that walks a new player through one call,
// moving on as they do each step. It runs on the first dispatcher shift and can be shown again
// from the help. Nothing here touches the simulation; it only reads what the player has done.

export interface TutorialState {
  calls: number; // calls so far this shift
  selected: boolean; // a call is selected
  sent: boolean; // a unit has been sent
  following: boolean; // riding along with a vehicle
}

interface Step {
  title: string;
  text: string;
  done: (s: TutorialState, shownFor: number) => boolean; // shownFor: seconds of real time
}

const STEPS: Step[] = [
  {
    title: 'Your first shift',
    text: 'Emergency calls come in with a chime. Each one appears in the call list on the right and as a pin on the map. Wait for the first call.',
    done: (s) => s.calls > 0,
  },
  {
    title: 'A call came in',
    text: 'Click it in the list, or click its pin. Critical calls (red) run out sooner and score 1.5 times.',
    done: (s) => s.selected,
  },
  {
    title: 'Send a unit',
    text: 'The panel lists the free units by how soon they can get there; the fastest is first. Pick one and press Assign, or just press Enter to send the fastest.',
    done: (s) => s.sent,
  },
  {
    title: 'On the way',
    text: 'With its siren on, cars ahead pull over and junctions are held for your unit. Click the unit, or press F, to ride along with it. Esc comes back.',
    done: (s, t) => s.following || t > 25,
  },
  {
    title: 'That is the job',
    text: 'Crash and fire calls need two units; send the second from the same call. Tab moves to the next waiting call. Too many missed calls ends the shift. Press ? for every key.',
    done: (_, t) => t > 12,
  },
];

const DONE_KEY = 'dispatch.tutorialDone';

export class Tutorial {
  private el: HTMLElement;
  private step = -1;
  private since = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tutorial';
    this.el.setAttribute('role', 'status');
    this.el.hidden = true;
    parent.append(this.el);
  }

  // Start if the player has not finished it before (or `force`).
  start(force = false): void {
    let done = false;
    try {
      done = localStorage.getItem(DONE_KEY) === '1';
    } catch {
      // storage blocked: show it every time
    }
    if (done && !force) return;
    this.show(0);
  }

  get active(): boolean {
    return this.step >= 0;
  }

  // Called every frame with what the player has done.
  update(state: TutorialState): void {
    if (this.step < 0) return;
    const shownFor = (performance.now() - this.since) / 1000;
    if (STEPS[this.step].done(state, shownFor)) {
      if (this.step + 1 < STEPS.length) this.show(this.step + 1);
      else this.finish();
    }
  }

  finish(): void {
    this.step = -1;
    this.el.hidden = true;
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      // storage blocked
    }
  }

  private show(k: number): void {
    this.step = k;
    this.since = performance.now();
    const s = STEPS[k];
    const head = document.createElement('div');
    head.className = 'tutorial-head';
    head.textContent = `${s.title} · ${k + 1}/${STEPS.length}`;
    const text = document.createElement('p');
    text.textContent = s.text;
    const skip = document.createElement('button');
    skip.textContent = k + 1 < STEPS.length ? 'Skip tutorial' : 'Got it';
    skip.onclick = () => this.finish();
    this.el.replaceChildren(head, text, skip);
    this.el.hidden = false;
  }
}
