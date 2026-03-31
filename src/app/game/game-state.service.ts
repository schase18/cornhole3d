import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ThrowResult = 'in_hole' | 'on_board' | 'miss';
export type BagSide = 'stick' | 'slick';

export interface GameStateSnapshot {
  totalScore: number;
  bagsIn: number;
  bagsOn: number;
  bagsOff: number;
  throwsRemaining: number;
  round: number;
  lastResult: ThrowResult | null;
  lastMessage: string;
  canThrow: boolean;
  /** Brief HUD row highlight after a scoring throw. */
  scoreboardFlashRow: 'in' | 'on' | 'off' | null;
}

const BAGS_PER_ROUND = 4;
const SCOREBOARD_FLASH_MS = 2000;

@Injectable({ providedIn: 'root' })
export class GameStateService {
  private scoreboardFlashClearTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly stateSubject = new BehaviorSubject<GameStateSnapshot>({
    totalScore: 0,
    bagsIn: 0,
    bagsOn: 0,
    bagsOff: 0,
    throwsRemaining: BAGS_PER_ROUND,
    round: 1,
    lastResult: null,
    lastMessage: 'Drag on the lawn, release to throw.',
    canThrow: true,
    scoreboardFlashRow: null,
  });

  readonly state$ = this.stateSubject.asObservable();

  bagSide: BagSide = 'stick';

  /** 1–10: how the stick side slides (higher = more run). */
  stickSpeed = 6;

  /** 1–10: how the slick side slides (higher = more run). */
  slickSpeed = 8;

  /** 0 = Low (5 ft peak), 1 = High (16 ft peak). */
  loftT = 0.5;

  get snapshot(): GameStateSnapshot {
    return this.stateSubject.value;
  }

  /** @returns whether aim mode actually started */
  beginThrow(): boolean {
    const s = this.stateSubject.value;
    if (!s.canThrow || s.throwsRemaining <= 0) {
      return false;
    }
    this.patch({ canThrow: false, lastMessage: 'Aiming…' });
    return true;
  }

  cancelThrow(): void {
    const s = this.stateSubject.value;
    if (s.throwsRemaining <= 0) {
      return;
    }
    this.patch({ canThrow: true, lastMessage: 'Drag on the lawn, release to throw.' });
  }

  recordSettledResult(result: ThrowResult): void {
    const s = this.stateSubject.value;
    let points = 0;
    let msg = '';
    switch (result) {
      case 'in_hole':
        points = 3;
        msg = 'In the hole! +3';
        break;
      case 'on_board':
        points = 1;
        msg = 'On the board. +1';
        break;
      case 'miss':
        msg = 'Miss.';
        break;
    }
    const totalScore = s.totalScore + points;
    const bagsIn = s.bagsIn + (result === 'in_hole' ? 1 : 0);
    const bagsOn = s.bagsOn + (result === 'on_board' ? 1 : 0);
    const bagsOff = s.bagsOff + (result === 'miss' ? 1 : 0);
    const throwsRemaining = s.throwsRemaining - 1;
    let round = s.round;
    let lastMessage = msg;
    if (throwsRemaining === 0) {
      round += 1;
      lastMessage = `${msg} End of round — rack reset.`;
    }

    const scoreboardFlashRow: 'in' | 'on' | 'off' | null =
      result === 'in_hole' ? 'in'
        : result === 'on_board' ? 'on'
          : 'off';

    this.clearScoreboardFlashTimer();
    this.stateSubject.next({
      totalScore,
      bagsIn,
      bagsOn,
      bagsOff,
      throwsRemaining: throwsRemaining === 0 ? BAGS_PER_ROUND : throwsRemaining,
      round,
      lastResult: result,
      lastMessage,
      /** Scene resets the bag after a short delay; re-enabled via prepareNextThrow(). */
      canThrow: false,
      scoreboardFlashRow,
    });

    if (scoreboardFlashRow !== null) {
      this.scoreboardFlashClearTimer = setTimeout(() => {
        this.scoreboardFlashClearTimer = null;
        this.patch({ scoreboardFlashRow: null });
      }, SCOREBOARD_FLASH_MS);
    }
  }

  /** Call after the bag is moved back to the throw line so the player can throw again. */
  prepareNextThrow(): void {
    this.patch({
      canThrow: true,
      lastMessage: 'Drag on the lawn, release to throw.',
    });
  }

  /** Clear score counters and restore a fresh round (used by Reset). */
  resetGame(): void {
    this.clearScoreboardFlashTimer();
    this.stateSubject.next({
      totalScore: 0,
      bagsIn: 0,
      bagsOn: 0,
      bagsOff: 0,
      throwsRemaining: BAGS_PER_ROUND,
      round: 1,
      lastResult: null,
      lastMessage: 'Drag on the lawn, release to throw.',
      canThrow: true,
      scoreboardFlashRow: null,
    });
  }

  private clearScoreboardFlashTimer(): void {
    if (this.scoreboardFlashClearTimer !== null) {
      clearTimeout(this.scoreboardFlashClearTimer);
      this.scoreboardFlashClearTimer = null;
    }
  }

  private patch(partial: Partial<GameStateSnapshot>): void {
    this.stateSubject.next({ ...this.stateSubject.value, ...partial });
  }
}
