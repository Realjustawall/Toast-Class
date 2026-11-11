// Test-only browser probe. Not imported by the application or included in its build.
import { Room, Track, LocalAudioTrack, LocalVideoTrack, RoomEvent } from 'livekit-client';
let room: Room;
let audio: AudioContext;
let oscillator: OscillatorNode;
let video: LocalVideoTrack;
let tick: ReturnType<typeof setInterval>;
let frame = 0;
export async function verifyBackgroundProcessor() {
  const { BackgroundProcessor, supportsBackgroundProcessors } =
    await import('@livekit/track-processors');
  if (!supportsBackgroundProcessors()) throw new Error('Background processing unsupported');
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d')!;
  const draw = () => {
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 320, 180);
  };
  draw();
  const timer = setInterval(draw, 100);
  const track = new LocalVideoTrack(canvas.captureStream(10).getVideoTracks()[0]);
  let frames = 0;
  const processor = BackgroundProcessor({
    mode: 'background-blur',
    maxFps: 15,
    assetPaths: {
      tasksVisionFileSet: '/media-effects/wasm',
      modelAssetPath: '/media-effects/selfie_segmenter.tflite',
    },
    onFrameProcessed: () => {
      frames++;
    },
  });
  try {
    await track.setProcessor(processor);
    const deadline = Date.now() + 10000;
    while (frames < 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const blurFrames = frames;
    await processor.switchTo({
      mode: 'virtual-background',
      imagePath: '/media-effects/background.svg',
    });
    const nextDeadline = Date.now() + 10000;
    while (frames < blurFrames + 3 && Date.now() < nextDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const replaceFrames = frames - blurFrames;
    await track.stopProcessor();
    return { blurFrames, replaceFrames, sourceAlive: track.mediaStreamTrack.readyState === 'live' };
  } finally {
    clearInterval(timer);
    await track.stopProcessor();
    track.stop();
  }
}
export async function connect(
  url: string,
  token: string,
  options: { singlePeerConnection?: boolean; relay?: boolean } = {},
) {
  room = new Room({
    adaptiveStream: false,
    dynacast: false,
    singlePeerConnection: options.singlePeerConnection,
  });
  await room.connect(
    url,
    token,
    options.relay ? { rtcConfig: { iceTransportPolicy: 'relay' } } : undefined,
  );
  return room.state;
}
export async function publish() {
  audio = new AudioContext();
  await audio.resume();
  oscillator = audio.createOscillator();
  oscillator.frequency.value = 440;
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  await room.localParticipant.publishTrack(
    new LocalAudioTrack(destination.stream.getAudioTracks()[0]),
    { source: Track.Source.Microphone },
  );
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  tick = setInterval(() => {
    frame++;
    ctx.fillStyle = frame % 2 ? '#ae471c' : '#eaf0e3';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#000';
    ctx.fillText(String(frame), 20, 30);
  }, 100);
  video = new LocalVideoTrack(canvas.captureStream(10).getVideoTracks()[0]);
  await room.localParticipant.publishTrack(video, {
    source: Track.Source.Camera,
    simulcast: false,
  });
}
export async function stats() {
  let audioBytes = 0,
    videoBytes = 0,
    frames = 0,
    tracks = 0;
  for (const participant of room.remoteParticipants.values())
    for (const pub of participant.trackPublications.values()) {
      if (!pub.track) continue;
      tracks++;
      const report = await pub.track.getRTCStatsReport();
      report?.forEach((stat) => {
        if (stat.type === 'inbound-rtp') {
          if (stat.kind === 'audio') audioBytes += stat.bytesReceived ?? 0;
          if (stat.kind === 'video') {
            videoBytes += stat.bytesReceived ?? 0;
            frames += stat.framesDecoded ?? 0;
          }
        }
      });
    }
  return { participants: room.remoteParticipants.size, audioBytes, videoBytes, frames, tracks };
}
export function publications() {
  return [...room.remoteParticipants.values()].map((p) => ({
    identity: p.identity,
    tracks: [...p.trackPublications.values()].map((t) => ({
      source: t.source,
      muted: t.isMuted,
      subscribed: t.isSubscribed,
      hasTrack: !!t.track,
    })),
  }));
}
export async function replaceVideo() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  clearInterval(tick);
  tick = setInterval(() => {
    frame++;
    ctx.fillStyle = '#1f6c9f';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#fff';
    ctx.fillText('replacement ' + frame, 10, 30);
  }, 100);
  await video.replaceTrack(canvas.captureStream(10).getVideoTracks()[0]);
}
export async function mute() {
  await video.mute();
  return video.isMuted;
}
export async function unmute() {
  await video.unmute();
  return video.isMuted;
}
export async function disconnect() {
  clearInterval(tick);
  try {
    oscillator?.stop();
  } catch {}
  video?.stop();
  await room?.disconnect();
  if (audio && audio.state !== 'closed') await audio.close();
  return room?.state ?? 'disconnected';
}
export function state() {
  return room.state;
}
export function permissions() {
  return room.localParticipant.permissions;
}
export async function attemptForbiddenPublish() {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const track = new LocalVideoTrack(canvas.captureStream(1).getVideoTracks()[0]);
  try {
    await room.localParticipant.publishTrack(track, { source: Track.Source.Camera });
    return false;
  } catch {
    return true;
  } finally {
    track.stop();
  }
}
