import { bootstrapApplication } from '@angular/platform-browser';
import { Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  template: `
    <main class="page">
      <section class="card">
        <div class="topbar">
          <div>
            <h1>Testre Live</h1>
            <p>Stream privada da galera</p>
          </div>
          <span class="status" [class.live]="isStreaming">
            {{ isStreaming ? 'AO VIVO' : 'OFFLINE' }}
          </span>
        </div>

        <div class="video-shell">
          <video #preview autoplay playsinline muted></video>
          <div class="empty" *ngIf="!isStreaming">
            <strong>Nenhuma transmissão ativa</strong>
            <span>Compartilhe sua tela para começar.</span>
          </div>
        </div>

        <div class="actions">
          <button (click)="startStream()" [disabled]="isStreaming">
            Compartilhar tela
          </button>
          <button class="secondary" (click)="stopStream()" [disabled]="!isStreaming">
            Parar transmissão
          </button>
        </div>
      </section>
    </main>
  `
})
export class AppComponent {
  @ViewChild('preview') preview!: ElementRef<HTMLVideoElement>;

  isStreaming = false;
  private mediaStream?: MediaStream;

  async startStream(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 60
      },
      audio: true
    });

    this.preview.nativeElement.srcObject = this.mediaStream;
    this.isStreaming = true;

    this.mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.stopStream();
    });
  }

  stopStream(): void {
    this.mediaStream?.getTracks().forEach(track => track.stop());
    this.mediaStream = undefined;
    this.preview.nativeElement.srcObject = null;
    this.isStreaming = false;
  }
}

bootstrapApplication(AppComponent).catch(console.error);
