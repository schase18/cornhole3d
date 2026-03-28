import { Routes } from '@angular/router';
import { GameCanvasComponent } from './game/game-canvas.component';

export const routes: Routes = [
  { path: '', component: GameCanvasComponent },
  { path: '**', redirectTo: '' },
];
