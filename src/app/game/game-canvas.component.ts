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

  ngOnDestroy(): void {
    this.scene.dispose();
  }
}
