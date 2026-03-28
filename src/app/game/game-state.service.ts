import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ThrowResult = 'in_hole' | 'on_board' | 'miss';

export interface GameStateSnapshot {
  totalScore: number;
  throwsRemaining: number;
  round: number;
  lastResult: ThrowResult | null;
  lastMessage: string;
  canThrow: boolean;
}

const BAGS_PER_ROUND = 4;

@Injectable({ providedIn: 'root' })
export class GameStateService {
  private readonly stateSubject = new BehaviorSubject<GameStateSnapshot>({
    totalScore: 0,
    throwsRemaining: BAGS_PER_ROUND,
    round: 1,
    lastResult: null,
    lastMessage: 'Drag on the lawn, release to throw.',
    canThrow: true,
  });

  readonly state$ = this.stateSubject.asObservable();

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
    const throwsRemaining = s.throwsRemaining - 1;
    let round = s.round;
    let lastMessage = msg;
    if (throwsRemaining === 0) {
      round += 1;
      lastMessage = `${msg} End of round — rack reset.`;
    }
    this.stateSubject.next({
      totalScore,
      throwsRemaining: throwsRemaining === 0 ? BAGS_PER_ROUND : throwsRemaining,
      round,
      lastResult: result,
      lastMessage,
      /** Scene resets the bag after a short delay; re-enabled via prepareNextThrow(). */
      canThrow: false,
    });
  }

  /** Call after the bag is moved back to the throw line so the player can throw again. */
  prepareNextThrow(): void {
    this.patch({
      canThrow: true,
      lastMessage: 'Drag on the lawn, release to throw.',
    });
  }

  private patch(partial: Partial<GameStateSnapshot>): void {
    this.stateSubject.next({ ...this.stateSubject.value, ...partial });
  }
}
