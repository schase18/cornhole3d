import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { CornholeSceneService } from './cornhole-scene.service';
import { GameStateService, BagSide } from './game-state.service';

@Component({
  selector: 'app-game-canvas',
  standalone: true,
  imports: [AsyncPipe],
  templateUrl: './game-canvas.component.html',
  styleUrl: './game-canvas.component.scss',
})
export class GameCanvasComponent implements AfterViewInit, OnDestroy {
  @ViewChild('renderCanvas', { static: true })
  renderCanvas!: ElementRef<HTMLCanvasElement>;

  private readonly scene = inject(CornholeSceneService);
  readonly gameState = inject(GameStateService);

  readonly speedOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

  ngAfterViewInit(): void {
    void this.scene.init(this.renderCanvas.nativeElement);
  }

  setBagSide(side: BagSide): void {
    this.gameState.bagSide = side;
    this.scene.flipBagToSide();
  }

  setLoft(event: Event): void {
    this.gameState.loftT = +(event.target as HTMLInputElement).value;
  }

  setStickSpeed(event: Event): void {
    this.gameState.stickSpeed = +(event.target as HTMLSelectElement).value;
  }

  setSlickSpeed(event: Event): void {
    this.gameState.slickSpeed = +(event.target as HTMLSelectElement).value;
  }

  resetGame(): void {
    this.scene.resetPractice();
    this.gameState.resetGame();
  }

  ngOnDestroy(): void {
    this.scene.dispose();
  }
}
