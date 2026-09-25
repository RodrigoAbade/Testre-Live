import { bootstrapApplication } from '@angular/platform-browser';
import { Component, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

type Signal =
  | { type: 'connected'; id: string }
  | { type: 'watch' }
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'stream-stopped' }
  | { type: 'peer-left'; id: string };

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <main class="page">
      <section class="card" *ngIf="!unlocked">
        <h1>Testre Live</h1>
        <p>Área privada da galera</p>
        <div class="login">
          <input type="password" [(ngModel)]="password" placeholder="Senha da sala" (keyup.enter)="unlock()">
          <button (click)="unlock()">Entrar</button>
        </div>
        <small *ngIf="loginError">Senha incorreta.</small>
      </section>

      <section class="card wide" *ngIf="unlocked">
        <div class="topbar">
          <div><h1>Testre Live</h1><p>Compartilhamento privado de tela</p></div>
          <span class="status" [class.live]="isStreaming">{{ isStreaming ? 'AO VIVO' : 'SALA ONLINE' }}</span>
        </div>

        <div class="video-shell">
          <video #video autoplay playsinline [muted]="isBroadcaster"></video>
          <div class="empty" *ngIf="!hasVideo">
            <strong>{{ isBroadcaster ? 'Preparando transmissão...' : 'Aguardando transmissão' }}</strong>
            <span>Você pode transmitir ou aguardar alguém iniciar.</span>
          </div>
        </div>

        <div class="actions">
          <button (click)="startStream()" [disabled]="isBroadcaster">Compartilhar tela</button>
          <button class="secondary" (click)="watch()">Assistir stream</button>
          <button class="danger" (click)="stopStream()" [disabled]="!isBroadcaster">Parar</button>
        </div>
        <p class="hint">{{ message }}</p>
      </section>
    </main>
  `
})
export class AppComponent implements OnDestroy {
  @ViewChild('video') video?: ElementRef<HTMLVideoElement>;

  password = '';
  unlocked = sessionStorage.getItem('testre-live-auth') === 'ok';
  loginError = false;
  isStreaming = false;
  isBroadcaster = false;
  hasVideo = false;
  message = 'Conectando ao servidor...';

  private socket?: WebSocket;
  private peer?: RTCPeerConnection;
  private mediaStream?: MediaStream;

  constructor() {
    if (this.unlocked) setTimeout(() => this.connect(), 0);
  }

  async unlock(): Promise<void> {
    try {
      const response = await fetch('http://localhost:8080/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: this.password })
      });

      if (!response.ok) {
        this.loginError = true;
        return;
      }

      sessionStorage.setItem('testre-live-auth', 'ok');
      this.unlocked = true;
      this.loginError = false;
      this.password = '';
      setTimeout(() => this.connect(), 0);
    } catch {
      this.loginError = true;
      this.message = 'Não foi possível conectar ao backend.';
    }
  }

  private connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const host = location.hostname || 'localhost';
    this.socket = new WebSocket(`${protocol}://${host}:8080/ws/signaling`);
    this.socket.onopen = () => this.message = 'Sala conectada.';
    this.socket.onclose = () => this.message = 'Servidor de sinalização desconectado.';
    this.socket.onmessage = event => this.handleSignal(JSON.parse(event.data) as Signal);
  }

  private newPeer(): RTCPeerConnection {
    this.peer?.close();
    this.peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    this.peer.onicecandidate = event => {
      if (event.candidate) this.send({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    this.peer.ontrack = event => {
      const stream = event.streams[0];
      if (this.video && stream) {
        this.video.nativeElement.srcObject = stream;
        this.hasVideo = true;
        this.isStreaming = true;
        this.message = 'Recebendo transmissão.';
      }
    };
    return this.peer;
  }

  async startStream(): Promise<void> {
    try {
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: true
      });
      this.isBroadcaster = true;
      this.isStreaming = true;
      this.hasVideo = true;
      this.message = 'Transmitindo. Seus amigos podem clicar em Assistir stream.';
      if (this.video) this.video.nativeElement.srcObject = this.mediaStream;
      this.mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopStream());
    } catch {
      this.message = 'Compartilhamento cancelado.';
    }
  }

  watch(): void {
    this.send({ type: 'watch' });
    this.message = 'Solicitando transmissão...';
  }

  private async handleSignal(signal: Signal): Promise<void> {
    if (signal.type === 'watch' && this.isBroadcaster && this.mediaStream) {
      const pc = this.newPeer();
      this.mediaStream.getTracks().forEach(track => pc.addTrack(track, this.mediaStream!));
      await pc.setLocalDescription(await pc.createOffer());
      this.send({ type: 'offer', sdp: pc.localDescription! });
    } else if (signal.type === 'offer' && !this.isBroadcaster) {
      const pc = this.newPeer();
      await pc.setRemoteDescription(signal.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      this.send({ type: 'answer', sdp: pc.localDescription! });
    } else if (signal.type === 'answer' && this.isBroadcaster && this.peer) {
      await this.peer.setRemoteDescription(signal.sdp);
    } else if (signal.type === 'ice' && this.peer) {
      try { await this.peer.addIceCandidate(signal.candidate); } catch {}
    } else if (signal.type === 'stream-stopped') {
      this.clearViewer();
    }
  }

  stopStream(): void {
    this.mediaStream?.getTracks().forEach(track => track.stop());
    this.mediaStream = undefined;
    this.peer?.close();
    this.peer = undefined;
    this.isBroadcaster = false;
    this.isStreaming = false;
    this.hasVideo = false;
    if (this.video) this.video.nativeElement.srcObject = null;
    this.send({ type: 'stream-stopped' });
    this.message = 'Transmissão encerrada.';
  }

  private clearViewer(): void {
    if (this.isBroadcaster) return;
    this.peer?.close();
    this.peer = undefined;
    this.isStreaming = false;
    this.hasVideo = false;
    if (this.video) this.video.nativeElement.srcObject = null;
    this.message = 'A transmissão foi encerrada.';
  }

  private send(data: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data));
  }

  ngOnDestroy(): void {
    this.mediaStream?.getTracks().forEach(track => track.stop());
    this.peer?.close();
    this.socket?.close();
  }
}

bootstrapApplication(AppComponent).catch(console.error);
