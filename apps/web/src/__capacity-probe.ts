// Test entry only; excluded from the production HTML entry and application imports.
import { Room, RoomEvent, Track, LocalAudioTrack, LocalVideoTrack } from 'livekit-client';
type Join = { id: string; url: string; token?: string; tokenUrl?: string };
const clients: { room: Room; publisher: boolean }[] = [];
const streams: MediaStreamTrack[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
let audio: AudioContext | undefined;
let attached = 0;
let attempted = 0;
let failures = 0;
export async function connect(joins: Join[], publisher = false) {
  const errors: string[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(1, joins.length) }, async () => {
      while (cursor < joins.length) {
        const join = joins[cursor++];
        attempted++;
        const room = new Room({
          adaptiveStream: false,
          dynacast: false,
          singlePeerConnection: false,
        });
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Video && attached < 2) {
            const video = document.createElement('video');
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.style.width = '160px';
            document.body.append(video);
            track.attach(video);
            attached++;
          }
        });
        try {
          // Obtain each grant immediately before that virtual user connects, as
          // the application does. Prefetching 800 short-lived grants is invalid.
          let token = join.token;
          if (join.tokenUrl) {
            const response = await fetch(join.tokenUrl, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error('Join grant failed: ' + response.status);
            token = (await response.json()).token;
          }
          if (!token) throw new Error('Missing join grant');
          await room.connect(join.url, token, { autoSubscribe: true });
          clients.push({ room, publisher });
        } catch (error) {
          failures++;
          errors.push(join.id + ': ' + String(error));
          if (errors.length <= 3) console.warn('Capacity connection failure: ' + String(error));
          await room.disconnect();
        }
      }
    }),
  );
  return { connected: clients.filter((c) => c.room.state === 'connected').length, errors };
}
export function progress() {
  return {
    attempted,
    connected: clients.filter((c) => c.room.state === 'connected').length,
    failures,
  };
}
export async function publish() {
  const room = clients.find((c) => c.publisher)?.room;
  if (!room) throw new Error('Publisher is not connected');
  audio = new AudioContext();
  await audio.resume();
  const oscillator = audio.createOscillator(),
    destination = audio.createMediaStreamDestination();
  oscillator.frequency.value = 440;
  oscillator.connect(destination);
  oscillator.start();
  const microphone = destination.stream.getAudioTracks()[0];
  streams.push(microphone);
  await room.localParticipant.publishTrack(new LocalAudioTrack(microphone), {
    source: Track.Source.Microphone,
  });
  for (const [source, width, height, fps] of [
    [Track.Source.Camera, 320, 180, 10],
    [Track.Source.ScreenShare, 640, 360, 5],
  ] as const) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    let frame = 0;
    const draw = () => {
      context.fillStyle = frame++ % 2 ? '#18324d' : '#0f70d7';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#fff';
      context.fillRect(frame % width, 20, 40, 60);
      context.fillText(String(frame), 30, 30);
    };
    draw();
    timers.push(setInterval(draw, 1000 / fps));
    const track = canvas.captureStream(fps).getVideoTracks()[0];
    streams.push(track);
    await room.localParticipant.publishTrack(new LocalVideoTrack(track), {
      source,
      simulcast: false,
    });
  }
  return room.localParticipant.trackPublications.size;
}
export async function stats() {
  let complete = 0,
    audioBytes = 0,
    cameraBytes = 0,
    screenBytes = 0,
    decodedFrames = 0;
  const receivers = clients.filter((c) => !c.publisher);
  for (const { room } of receivers) {
    const received = { audio: 0, camera: 0, screen: 0 };
    for (const person of room.remoteParticipants.values())
      for (const publication of person.trackPublications.values()) {
        const trackId = publication.track?.mediaStreamTrack.id;
        const report = await publication.track?.getRTCStatsReport();
        report?.forEach((stat) => {
          if (stat.type !== 'inbound-rtp' || !trackId || stat.trackIdentifier !== trackId) return;
          const bytes = stat.bytesReceived ?? 0;
          if (stat.kind === 'audio') received.audio += bytes;
          else if (publication.source === Track.Source.ScreenShare) received.screen += bytes;
          else received.camera += bytes;
          decodedFrames += stat.framesDecoded ?? 0;
        });
      }
    if (received.audio > 0 && received.camera > 0 && received.screen > 0) complete++;
    audioBytes += received.audio;
    cameraBytes += received.camera;
    screenBytes += received.screen;
  }
  return {
    connected: clients.filter((c) => c.room.state === 'connected').length,
    receivers: receivers.length,
    complete,
    audioBytes,
    cameraBytes,
    screenBytes,
    decodedFrames,
  };
}
export async function disconnect() {
  for (const timer of timers) clearInterval(timer);
  for (const track of streams) track.stop();
  await Promise.allSettled(clients.map((c) => c.room.disconnect()));
  clients.length = 0;
  if (audio && audio.state !== 'closed') await audio.close();
}
