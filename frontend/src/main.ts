import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { Component, ElementRef, ViewChildren, QueryList, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

type StreamInfo = { streamId: string; broadcasterId: string; name: string };
type Signal = any;
type ViewerConnection = { peer: RTCPeerConnection; streamId: string };

@Component({
  selector: 'app-root', standalone: true, imports: [CommonModule, FormsModule],
  template: `
    <main class="page">
      <section class="card" *ngIf="!unlocked">
        <h1>Testre Live</h1><p>Área privada da galera</p>
        <div class="login"><input type="password" [(ngModel)]="password" placeholder="Senha da sala" (keyup.enter)="unlock()"><button (click)="unlock()">Entrar</button></div>
        <small *ngIf="loginError">Senha incorreta.</small>
      </section>

      <section class="card wide" *ngIf="unlocked">
        <div class="topbar"><div><h1>Testre Live</h1><p>Compartilhamento privado de tela</p></div><span class="status" [class.live]="!!myStreamId">{{ myStreamId ? 'VOCÊ ESTÁ AO VIVO' : 'SALA ONLINE' }}</span></div>
        <div class="broadcast-controls">
          <input [(ngModel)]="streamName" placeholder="Nome da sua live">
          <button (click)="startStream()" [disabled]="!!myStreamId">Compartilhar tela</button>
          <button class="danger" (click)="stopStream()" [disabled]="!myStreamId">Parar minha live</button>
        </div>

        <div class="video-shell" *ngIf="myStreamId">
          <video #video autoplay playsinline muted [attr.data-stream-id]="myStreamId"></video>
          <div class="stream-label">Sua live: {{ streamName || 'Minha live' }}</div>
        </div>

        <h2>Lives disponíveis</h2>
        <p *ngIf="otherStreams.length === 0" class="hint">Nenhuma outra live no momento.</p>
        <div class="streams-grid">
          <article class="stream-card" *ngFor="let stream of otherStreams">
            <div class="stream-header"><strong>{{ stream.name }}</strong><span class="status live">AO VIVO</span></div>
            <div class="video-shell">
              <video #video autoplay playsinline [attr.data-stream-id]="stream.streamId"></video>
              <div class="empty" *ngIf="!watching.has(stream.streamId)"><strong>{{ stream.name }}</strong><span>Clique em assistir quando quiser abrir esta live.</span></div>
            </div>
            <div class="actions">
              <button (click)="watch(stream)" *ngIf="!watching.has(stream.streamId)">Assistir</button>
              <button class="secondary" (click)="leaveStream(stream.streamId)" *ngIf="watching.has(stream.streamId)">Não assistir</button>
              <button class="secondary" (click)="toggleMute(stream.streamId)" *ngIf="watching.has(stream.streamId)">{{ mutedStreams.has(stream.streamId) ? '🔊 Ativar som' : '🔇 Mutar' }}</button>
              <label class="volume-control" *ngIf="watching.has(stream.streamId)"><span>🔊</span><input type="range" min="0" max="100" [value]="volumeOf(stream.streamId)" (input)="setVolume(stream.streamId, $event)"><span>{{ volumeOf(stream.streamId) }}%</span></label>
            </div>
          </article>
        </div>
        <p class="hint">{{ message }}</p>
      </section>
    </main>`
})
export class AppComponent implements OnDestroy {
  @ViewChildren('video') videos?: QueryList<ElementRef<HTMLVideoElement>>;
  password=''; streamName=''; unlocked=sessionStorage.getItem('testre-live-auth')==='ok'; loginError=false; message='Conectando ao servidor...'; clientId=''; myStreamId?:string; streams:StreamInfo[]=[]; watching=new Set<string>(); mutedStreams=new Set<string>(); volumes=new Map<string,number>();
  private socket?:WebSocket; private mediaStream?:MediaStream; private broadcasterPeers=new Map<string,RTCPeerConnection>(); private viewerPeers=new Map<string,ViewerConnection>();
  get otherStreams(){return this.streams.filter(x=>x.broadcasterId!==this.clientId)}
  constructor(){if(this.unlocked)setTimeout(()=>this.connect(),0)}
  private get apiBase(){const configured=(window as any).__TESTRE_API_URL__ as string|undefined;return configured||(location.hostname==='localhost'?'http://localhost:8080':location.origin)}
  private get wsBase(){return this.apiBase.replace(/^http/,'ws')}

  async unlock(){try{const response=await fetch(`${this.apiBase}/api/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:this.password})});if(!response.ok){this.loginError=true;return}sessionStorage.setItem('testre-live-auth','ok');this.unlocked=true;this.loginError=false;this.password='';setTimeout(()=>this.connect(),0)}catch{this.loginError=true;this.message='Não foi possível conectar ao backend.'}}
  private connect(){this.socket=new WebSocket(`${this.wsBase}/ws/signaling`);this.socket.onopen=()=>this.message='Sala conectada.';this.socket.onclose=()=>this.message='Servidor de sinalização desconectado.';this.socket.onmessage=e=>this.handleSignal(JSON.parse(e.data))}

  async startStream(){try{this.mediaStream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:60},audio:true});this.send({type:'start-stream',name:this.streamName||'Minha live'});this.message='Preparando sua transmissão...';this.mediaStream.getVideoTracks()[0]?.addEventListener('ended',()=>this.stopStream())}catch{this.message='Compartilhamento cancelado.'}}
  stopStream(){if(this.myStreamId)this.send({type:'stop-stream',streamId:this.myStreamId});this.mediaStream?.getTracks().forEach(t=>t.stop());this.mediaStream=undefined;this.broadcasterPeers.forEach(p=>p.close());this.broadcasterPeers.clear();this.myStreamId=undefined;this.message='Sua transmissão foi encerrada.'}
  watch(stream:StreamInfo){if(this.watching.has(stream.streamId))return;this.watching.add(stream.streamId);this.volumes.set(stream.streamId,100);this.send({type:'watch',streamId:stream.streamId});this.message=`Solicitando ${stream.name}...`}
  leaveStream(streamId:string){this.viewerPeers.get(streamId)?.peer.close();this.viewerPeers.delete(streamId);this.watching.delete(streamId);this.mutedStreams.delete(streamId);this.volumes.delete(streamId);const video=this.findVideo(streamId);if(video)video.srcObject=null}
  toggleMute(streamId:string){const video=this.findVideo(streamId);if(!video)return;video.muted=!video.muted;if(video.muted)this.mutedStreams.add(streamId);else this.mutedStreams.delete(streamId)}
  volumeOf(streamId:string){return this.volumes.get(streamId)??100}
  setVolume(streamId:string,event:Event){const value=Number((event.target as HTMLInputElement).value);this.volumes.set(streamId,value);const video=this.findVideo(streamId);if(video){video.volume=value/100;if(value===0){video.muted=true;this.mutedStreams.add(streamId)}else if(this.mutedStreams.has(streamId)){video.muted=false;this.mutedStreams.delete(streamId)}}}

  private async handleSignal(signal:Signal){
    if(signal.type==='connected'){this.clientId=signal.id;this.streams=signal.streams||[];return}
    if(signal.type==='stream-created'){
      this.myStreamId=signal.stream.streamId;this.upsertStream(signal.stream);
      setTimeout(()=>this.attachLocalPreview(),0);this.message='Você está transmitindo.';return
    }
    if(signal.type==='stream-started'){this.upsertStream(signal.stream);return}
    if(signal.type==='stream-stopped'){this.streams=this.streams.filter(x=>x.streamId!==signal.streamId);this.leaveStream(signal.streamId);return}
    if(signal.type==='watch'&&signal.streamId===this.myStreamId&&this.mediaStream){const pc=this.createPeer(signal.viewerId,signal.streamId,true);this.mediaStream.getTracks().forEach(t=>pc.addTrack(t,this.mediaStream!));await pc.setLocalDescription(await pc.createOffer());this.send({type:'offer',targetId:signal.viewerId,streamId:signal.streamId,sdp:pc.localDescription});return}
    if(signal.type==='offer'){const pc=this.createPeer(signal.senderId,signal.streamId,false);await pc.setRemoteDescription(signal.sdp);await pc.setLocalDescription(await pc.createAnswer());this.send({type:'answer',targetId:signal.senderId,streamId:signal.streamId,sdp:pc.localDescription});return}
    if(signal.type==='answer'){const pc=this.broadcasterPeers.get(signal.senderId);if(pc)await pc.setRemoteDescription(signal.sdp);return}
    if(signal.type==='ice'){const pc=this.broadcasterPeers.get(signal.senderId)||this.viewerPeers.get(signal.streamId)?.peer;if(pc)try{await pc.addIceCandidate(signal.candidate)}catch{}}
  }

  private attachLocalPreview(){if(!this.myStreamId||!this.mediaStream)return;const tryAttach=()=>{const video=this.findVideo(this.myStreamId!);if(video){video.srcObject=this.mediaStream!;video.muted=true;video.play().catch(()=>{});return true}return false};if(tryAttach())return;let attempts=0;const timer=setInterval(()=>{attempts++;if(tryAttach()||attempts>=20)clearInterval(timer)},50)}
  private createPeer(remoteId:string,streamId:string,broadcaster:boolean){const existing=broadcaster?this.broadcasterPeers.get(remoteId):this.viewerPeers.get(streamId)?.peer;existing?.close();const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});pc.onicecandidate=e=>{if(e.candidate)this.send({type:'ice',targetId:remoteId,streamId,candidate:e.candidate.toJSON()})};if(!broadcaster){pc.ontrack=e=>{const attach=()=>{const video=this.findVideo(streamId);if(video&&e.streams[0]){video.srcObject=e.streams[0];video.volume=this.volumeOf(streamId)/100;video.muted=this.mutedStreams.has(streamId);video.play().catch(()=>{});return true}return false};if(!attach())setTimeout(attach,50)};this.viewerPeers.set(streamId,{peer:pc,streamId})}else this.broadcasterPeers.set(remoteId,pc);return pc}
  private upsertStream(stream:StreamInfo){this.streams=[...this.streams.filter(x=>x.streamId!==stream.streamId),stream]}
  private findVideo(streamId:string){return this.videos?.find(x=>x.nativeElement.dataset['streamId']===streamId)?.nativeElement}
  private send(data:object){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(data))}
  ngOnDestroy(){this.mediaStream?.getTracks().forEach(t=>t.stop());this.broadcasterPeers.forEach(p=>p.close());this.viewerPeers.forEach(c=>c.peer.close());this.socket?.close()}
}
bootstrapApplication(AppComponent,{providers:[provideZonelessChangeDetection()]}).catch(console.error);
