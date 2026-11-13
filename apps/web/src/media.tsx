import {
  RoomContext,
  RoomAudioRenderer,
  StartAudio,
  DisconnectButton,
  useTracks,
  useConnectionState,
  useConnectionQualityIndicator,
  useLocalParticipantPermissions,
  useMediaDeviceSelect,
  useIsSpeaking,
  useIsMuted,
  useLocalParticipant,
  useTrackVolume,
} from '@livekit/components-react';
import type { TrackReferenceOrPlaceholder } from '@livekit/components-core';
import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  LocalVideoTrack,
  createLocalAudioTrack,
  type LocalAudioTrack,
} from 'livekit-client';
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  createContext,
  useContext,
  useMemo,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { MediaIntent, ParticipantMediaState } from './classroom-types';
import { createPortal } from 'react-dom';
import ClassIcon from './classroom-icons';
import { participantAvatarStyle } from './participant-identity';
const ModeratorContext = createContext<ReadonlySet<string>>(new Set());
import { playClassroomSound } from './classroom-sounds';
// The app owns one media stage. Finish its captures and transport teardown
// before another room starts acquiring the same browser devices.
let mediaHandoff: Promise<void> = Promise.resolve();
type MediaOperation = (task: () => Promise<void>) => Promise<void>;
export default function Media({
  token,
  url,
  onLeave,
  onError,
  initialIntent,
  onIntentChange,
  onUserDisconnect,
  controlsTarget,
  onScreenShareChange,
  onSpeakersChange,
  onParticipantMediaChange,
  galleryTarget,
  moderatorIds = [],
  refreshJoin,
}: {
  token: string;
  url: string;
  onLeave: () => void;
  onError: (e: Error) => void;
  initialIntent?: MediaIntent;
  onIntentChange?: (intent: MediaIntent) => void;
  onUserDisconnect?: () => void;
  controlsTarget?: HTMLElement | null;
  onScreenShareChange?: (sharing: boolean) => void;
  onSpeakersChange?: (identities: string[]) => void;
  onParticipantMediaChange?: (participants: ParticipantMediaState[]) => void;
  galleryTarget?: HTMLElement | null;
  moderatorIds?: string[];
  refreshJoin?: () => Promise<{
    token: string;
    url: string;
    policy?: { microphone: boolean; camera: boolean };
  }>;
}) {
  const { t } = useTranslation();
  const moderators = useMemo(() => new Set(moderatorIds), [moderatorIds]);
  const [room] = useState(
    () =>
      new Room({
        singlePeerConnection: false,
        adaptiveStream: false,
        dynacast: false,
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
        audioCaptureDefaults: {
          noiseSuppression: localStorage.getItem('microphone-processing') !== 'false',
          echoCancellation: localStorage.getItem('microphone-processing') !== 'false',
          autoGainControl: true,
        },
        publishDefaults: {
          simulcast: false,
          degradationPreference: 'maintain-framerate',
          videoEncoding: { maxBitrate: 1_000_000, maxFramerate: 30 },
          screenShareEncoding: { maxBitrate: 1_500_000, maxFramerate: 30 },
        },
      }),
  );
  const callbacks = useRef({ onLeave, onError, refreshJoin });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const accepting = useRef(true);
  const operate: MediaOperation = useCallback((task) => {
    const job = queue.current.then(async () => {
      if (accepting.current) await task();
    });
    queue.current = job.catch(() => {});
    return job;
  }, []);
  const resume = useRef(initialIntent);
  const [resuming, setResuming] = useState(!!initialIntent);
  const [connecting, setConnecting] = useState(true);
  useEffect(() => {
    const changed = () => {
      onSpeakersChange?.(
        [room.localParticipant, ...room.remoteParticipants.values()]
          .filter((person) => person.isSpeaking && person.isMicrophoneEnabled)
          .map((person) => person.identity),
      );
      onParticipantMediaChange?.(
        [room.localParticipant, ...room.remoteParticipants.values()].map((person) => ({
          id: person.identity,
          microphone: person.isMicrophoneEnabled,
          camera: person.isCameraEnabled,
          screenShare: person.isScreenShareEnabled,
        })),
      );
    };
    const events = [
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.Connected,
    ];
    for (const event of events) room.on(event, changed);
    changed();
    return () => {
      for (const event of events) room.off(event, changed);
      onSpeakersChange?.([]);
      onParticipantMediaChange?.([]);
    };
  }, [room, onSpeakersChange, onParticipantMediaChange]);
  callbacks.current = { onLeave, onError, refreshJoin };
  const handleError = useCallback((e: Error) => {
    playClassroomSound('error');
    callbacks.current.onError(e);
  }, []);
  useEffect(() => {
    let active = true;
    let capturedAudio: LocalAudioTrack | undefined;
    accepting.current = true;
    const previous = mediaHandoff;
    const disconnected = () => {
      if (active) {
        playClassroomSound('disconnected');
        callbacks.current.onLeave();
      }
    };
    const reconnecting = () => playClassroomSound('reconnecting');
    room.on(RoomEvent.Reconnecting, reconnecting);
    const error = (e: Error) => {
      if (active) {
        playClassroomSound('error');
        callbacks.current.onError(e);
      }
    };
    room.on(RoomEvent.Disconnected, disconnected).on(RoomEvent.MediaDevicesError, error);
    // Defer initial connection so React's development remount does not race an ICE handshake.
    const start = setTimeout(() => {
      void operate(async () => {
        await previous;
        if (!active) return;
        try {
          // Recheck moderator authorization before opening any browser device,
          // including when moving between a parent room and a breakout room.
          let grant = callbacks.current.refreshJoin
            ? await callbacks.current.refreshJoin()
            : { url, token, policy: undefined };
          if (!active) return;
          if (grant.policy && resume.current)
            resume.current = {
              microphone: resume.current.microphone && grant.policy.microphone,
              camera: resume.current.camera && grant.policy.camera,
            };
          const consentStarted = Date.now();
          // Capture only after an explicit microphone choice and a policy check.
          // Listen-only joins skip capture entirely. Keep the granted track
          // for publication after the authorized media connection succeeds.
          if (resume.current?.microphone) {
            capturedAudio = await createLocalAudioTrack(room.options.audioCaptureDefaults);
            if (!active) {
              capturedAudio.stop();
              capturedAudio = undefined;
              return;
            }
          }
          if (Date.now() - consentStarted > 30000 && callbacks.current.refreshJoin)
            grant = await callbacks.current.refreshJoin();
          if (!active) {
            capturedAudio?.stop();
            capturedAudio = undefined;
            return;
          }
          playClassroomSound('connecting');
          await room.connect(grant.url, grant.token);
          if (active) playClassroomSound('connected');
        } catch (e) {
          capturedAudio?.stop();
          capturedAudio = undefined;
          const name = (e as Error).name;
          error(
            new Error(
              t(
                name === 'NotAllowedError'
                  ? 'mediaPermissionDenied'
                  : name === 'NotFoundError'
                    ? 'mediaDeviceMissing'
                    : name === 'NotReadableError'
                      ? 'mediaDeviceBusy'
                      : 'mediaConnectionFailed',
              ),
            ),
          );
          if (active) callbacks.current.onLeave();
          return;
        }
        const participant = room.localParticipant;
        const policy = participant.permissions;
        const permitted = (source: number) =>
          !!policy?.canPublish &&
          (!policy.canPublishSources.length || policy.canPublishSources.includes(source));
        try {
          if (active && resume.current?.microphone && permitted(2)) {
            if (capturedAudio) {
              await participant.publishTrack(capturedAudio, { source: Track.Source.Microphone });
              capturedAudio = undefined;
            } else await participant.setMicrophoneEnabled(true);
          }
          capturedAudio?.stop();
          capturedAudio = undefined;
          if (active && resume.current?.camera && permitted(1))
            await participant.setCameraEnabled(true);
        } catch (e) {
          error(e as Error);
        } finally {
          capturedAudio?.stop();
          capturedAudio = undefined;
          if (active) {
            setResuming(false);
            setConnecting(false);
          } else {
            await participant.setMicrophoneEnabled(false).catch(() => {});
            await participant.setCameraEnabled(false).catch(() => {});
          }
        }
      }).catch(error);
    }, 0);
    return () => {
      active = false;
      accepting.current = false;
      clearTimeout(start);
      room.off(RoomEvent.Disconnected, disconnected).off(RoomEvent.MediaDevicesError, error);
      room.off(RoomEvent.Reconnecting, reconnecting);
      const pending = queue.current;
      mediaHandoff = (async () => {
        capturedAudio?.stop();
        await room.disconnect();
        await pending;
        // A capture request may have resolved after disconnect cleared the
        // participant's original publications; stop any such late track too.
        for (const publication of room.localParticipant.trackPublications.values())
          publication.track?.stop();
        await room.disconnect();
      })();
      void mediaHandoff.catch(() => {});
    };
  }, [room, url, token]);
  return (
    <ModeratorContext.Provider value={moderators}>
      <RoomContext.Provider value={room}>
        {connecting &&
          (() => {
            const pending = (
              <div className="media-connection-inline" role="status">
                <span>{t('mediaConnectingHint')}</span>
                <button
                  onClick={() => {
                    onUserDisconnect?.();
                    callbacks.current.onLeave();
                  }}
                >
                  {t('cancel')}
                </button>
              </div>
            );
            return controlsTarget ? createPortal(pending, controlsTarget) : pending;
          })()}
        <div
          data-lk-theme="default"
          data-resume-camera={resume.current?.camera}
          data-resume-microphone={resume.current?.microphone}
          data-resuming={resuming}
        >
          {!connecting && (
            <MediaRoom
              onError={handleError}
              resuming={resuming}
              operate={operate}
              onIntentChange={onIntentChange}
              onUserDisconnect={onUserDisconnect}
              controlsTarget={controlsTarget}
              onScreenShareChange={onScreenShareChange}
              galleryTarget={galleryTarget}
            />
          )}
        </div>
      </RoomContext.Provider>
    </ModeratorContext.Provider>
  );
}

function MediaRoom({
  onError,
  resuming,
  onIntentChange,
  onUserDisconnect,
  operate,
  controlsTarget,
  onScreenShareChange,
  galleryTarget,
}: {
  onError: (e: Error) => void;
  resuming: boolean;
  onIntentChange?: (intent: MediaIntent) => void;
  onUserDisconnect?: () => void;
  operate: MediaOperation;
  controlsTarget?: HTMLElement | null;
  onScreenShareChange?: (sharing: boolean) => void;
  galleryTarget?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const tracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: true },
    { source: Track.Source.ScreenShare, withPlaceholder: false },
  ]);
  const connection = useConnectionState();
  const {
    microphoneTrack,
    cameraTrack,
    localParticipant,
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
  } = useLocalParticipant();
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  const permissions = useLocalParticipantPermissions();
  const permissionKey = permissions
    ? String(permissions.canPublish) + ':' + permissions.canPublishSources.join(',')
    : '';
  useEffect(() => {
    if (!permissions) return;
    void operate(async () => {
      const current = localParticipant.permissions;
      if (!current) return;
      for (const [source, number] of [
        [Track.Source.Microphone, 2],
        [Track.Source.Camera, 1],
        [Track.Source.ScreenShare, 3],
      ] as const) {
        if (
          current.canPublish &&
          (!current.canPublishSources.length || current.canPublishSources.includes(number))
        )
          continue;
        const track = localParticipant.getTrackPublication(source)?.track;
        if (track) await localParticipant.unpublishTrack(track, true);
      }
      onIntentChange?.({
        microphone: localParticipant.isMicrophoneEnabled,
        camera: localParticipant.isCameraEnabled,
      });
    }).catch(onError);
  }, [permissionKey, localParticipant]);
  const [processing, setProcessing] = useState(
    () => localStorage.getItem('microphone-processing') !== 'false',
  );
  useEffect(() => {
    const track = microphoneTrack?.track?.mediaStreamTrack;
    if (track)
      void track
        .applyConstraints({
          echoCancellation: processing,
          noiseSuppression: processing,
          autoGainControl: true,
        })
        .catch(onError);
  }, [microphoneTrack, processing, onError]);
  const volume = useTrackVolume(
    microphoneTrack
      ? {
          publication: microphoneTrack,
          participant: localParticipant,
          source: Track.Source.Microphone,
        }
      : undefined,
  );
  const [mediaBusy, setMediaBusy] = useState(false);
  const [background, setBackground] = useState<'off' | 'blur' | 'replace'>('off');
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [backgroundSupported, setBackgroundSupported] = useState(false);
  useEffect(() => {
    let active = true;
    void import('@livekit/track-processors')
      .then((module) => {
        if (active) setBackgroundSupported(module.supportsBackgroundProcessors());
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const changeBackground = async (mode: typeof background) => {
    if (backgroundBusy) return;
    setBackgroundBusy(true);
    try {
      await operate(async () => {
        const track = cameraTrack?.track;
        if (!(track instanceof LocalVideoTrack) || !localParticipant.isCameraEnabled) return;
        if (mode === 'off') await track.stopProcessor();
        else {
          const { BackgroundProcessor } = await import('@livekit/track-processors');
          await track.setProcessor(
            BackgroundProcessor({
              ...(mode === 'blur'
                ? { mode: 'background-blur' as const, blurRadius: 10 }
                : {
                    mode: 'virtual-background' as const,
                    imagePath: '/media-effects/background.svg',
                  }),
              assetPaths: {
                tasksVisionFileSet: '/media-effects/wasm',
                modelAssetPath: '/media-effects/selfie_segmenter.tflite',
              },
              maxFps: 20,
            }),
          );
        }
        setBackground(mode);
      });
    } catch (error) {
      setBackground('off');
      onError(error as Error);
    } finally {
      setBackgroundBusy(false);
    }
  };
  useEffect(() => {
    setBackground('off');
  }, [cameraTrack?.track]);
  const toggle = async (source: Track.Source) => {
    if (mediaBusy || resuming || !allowed(source)) return;
    setMediaBusy(true);
    try {
      await operate(async () => {
        // Permissions may change while another device operation is queued.
        const current = localParticipant.permissions;
        const number =
          source === Track.Source.Microphone ? 2 : source === Track.Source.Camera ? 1 : 3;
        if (
          !current?.canPublish ||
          (current.canPublishSources.length && !current.canPublishSources.includes(number))
        )
          return;
        if (source === Track.Source.Camera)
          await localParticipant.setCameraEnabled(!localParticipant.isCameraEnabled);
        else if (source === Track.Source.Microphone)
          await localParticipant.setMicrophoneEnabled(!localParticipant.isMicrophoneEnabled);
        else
          await localParticipant.setScreenShareEnabled(!localParticipant.isScreenShareEnabled, {
            contentHint: 'detail',
          });
        const enabled =
          source === Track.Source.Camera
            ? localParticipant.isCameraEnabled
            : source === Track.Source.Microphone
              ? localParticipant.isMicrophoneEnabled
              : localParticipant.isScreenShareEnabled;
        playClassroomSound(
          source === Track.Source.Microphone
            ? enabled
              ? 'microphoneOn'
              : 'microphoneOff'
            : source === Track.Source.Camera
              ? enabled
                ? 'cameraOn'
                : 'cameraOff'
              : enabled
                ? 'screenOn'
                : 'screenOff',
        );
        onIntentChange?.({
          microphone: localParticipant.isMicrophoneEnabled,
          camera: localParticipant.isCameraEnabled,
        });
      });
    } catch (e) {
      onError(e as Error);
    } finally {
      setMediaBusy(false);
    }
  };
  const [layout, setLayout] = useState<'auto' | 'grid' | 'focus'>(() => {
    const value = localStorage.getItem('media-layout');
    return value === 'grid' || value === 'focus' ? value : 'auto';
  });
  const [pinned, setPinned] = useState('');
  const [videoPage, setVideoPage] = useState(0);
  const videoPages = Math.max(1, Math.ceil(tracks.length / 12));
  const currentVideoPage = Math.min(videoPage, videoPages - 1);
  const pageTracks = tracks.slice(currentVideoPage * 12, (currentVideoPage + 1) * 12);
  const [mirror, setMirror] = useState(localStorage.getItem('media-mirror') !== 'false');
  const allowed = (source: Track.Source) =>
    connection === 'connected' &&
    !!permissions?.canPublish &&
    (!permissions.canPublishSources.length ||
      permissions.canPublishSources.includes(
        source === Track.Source.Microphone ? 2 : source === Track.Source.Camera ? 1 : 3,
      ));
  const screen = tracks.find((tr) => tr.source === Track.Source.ScreenShare);
  const videoTarget = screen ? null : galleryTarget;
  useEffect(() => {
    onScreenShareChange?.(!!screen);
    return () => onScreenShareChange?.(false);
  }, [!!screen, onScreenShareChange]);
  const focused =
    layout === 'auto'
      ? (screen ?? tracks[0])
      : (tracks.find((tr) => tr.participant.identity + ':' + tr.source === pinned) ??
        screen ??
        tracks[0]);
  const shown =
    layout === 'focus' || (layout === 'auto' && screen) ? (focused ? [focused] : []) : pageTracks;
  const changeLayout = (value: typeof layout) => {
    setLayout(value);
    localStorage.setItem('media-layout', value);
  };
  const toolbar = (
    <div className="media-toolbar">
      <button
        className="lk-button"
        disabled={mediaBusy || resuming || !allowed(Track.Source.Microphone)}
        title={
          !allowed(Track.Source.Microphone) && connection === 'connected'
            ? t('microphoneLockedByModerator')
            : t('microphone') + ' · ' + t(isMicrophoneEnabled ? 'mediaEnabled' : 'mediaDisabled')
        }
        aria-pressed={isMicrophoneEnabled}
        data-lk-enabled={isMicrophoneEnabled}
        onClick={() => void toggle(Track.Source.Microphone)}
      >
        <ClassIcon
          name={
            !allowed(Track.Source.Microphone) && connection === 'connected'
              ? 'lock'
              : isMicrophoneEnabled
                ? 'mic'
                : 'micOff'
          }
        />
        <span className="sr-only">{t('microphone')}</span>
      </button>
      <button
        className="lk-button"
        disabled={mediaBusy || resuming || !allowed(Track.Source.Camera)}
        title={
          !allowed(Track.Source.Camera) && connection === 'connected'
            ? t('cameraLockedByModerator')
            : t('camera') + ' · ' + t(isCameraEnabled ? 'mediaEnabled' : 'mediaDisabled')
        }
        aria-pressed={isCameraEnabled}
        data-lk-enabled={isCameraEnabled}
        onClick={() => void toggle(Track.Source.Camera)}
      >
        <ClassIcon
          name={
            !allowed(Track.Source.Camera) && connection === 'connected'
              ? 'lock'
              : isCameraEnabled
                ? 'cam'
                : 'camOff'
          }
        />
        <span className="sr-only">{t('camera')}</span>
      </button>
      <button
        className="lk-button"
        disabled={mediaBusy || resuming || !allowed(Track.Source.ScreenShare)}
        title={
          t('shareScreen') + ' · ' + t(isScreenShareEnabled ? 'mediaEnabled' : 'mediaDisabled')
        }
        aria-pressed={isScreenShareEnabled}
        data-lk-enabled={isScreenShareEnabled}
        onClick={() => void toggle(Track.Source.ScreenShare)}
      >
        <ClassIcon name="screen" />
        <span className="sr-only">{t('shareScreen')}</span>
      </button>
      <meter min={0} max={1} value={volume} aria-label={t('microphoneLevel')} />
      <DisconnectButton onClick={onUserDisconnect}>
        <ClassIcon name="leave" />
        <span className="sr-only">{t('disconnectMedia')}</span>
      </DisconnectButton>
    </div>
  );
  return (
    <div className="toaster-media-room">
      <div className="media-status">
        <span role="status">
          {t('connection_' + connection)}
          {quality !== 'unknown' && <> · {t('quality_' + quality)}</>}
        </span>
        <div className="actions">
          {(['auto', 'grid', 'focus'] as const).map((value) => (
            <button
              key={value}
              aria-pressed={layout === value}
              title={t('layout_' + value)}
              onClick={() => changeLayout(value)}
            >
              <ClassIcon
                name={value === 'grid' ? 'grid' : value === 'focus' ? 'presenter' : 'layout'}
                size={14}
              />
              <span className="sr-only">{t('layout_' + value)}</span>
            </button>
          ))}
        </div>
      </div>
      {videoPages > 1 && (
        <nav className="classroom-pagination" aria-label={t('classroomGallery')}>
          <button
            disabled={currentVideoPage === 0}
            onClick={() => setVideoPage(currentVideoPage - 1)}
          >
            {t('previousPage')}
          </button>
          <span>{t('pageOf', { page: currentVideoPage + 1, total: videoPages })}</span>
          <button
            disabled={currentVideoPage >= videoPages - 1}
            onClick={() => setVideoPage(currentVideoPage + 1)}
          >
            {t('nextPage')}
          </button>
        </nav>
      )}
      <div className="media-tiles">
        {!videoTarget &&
          shown.map((tr) => (
            <MediaTile
              key={tr.participant.identity + ':' + tr.source}
              track={tr}
              mirror={mirror}
              onPin={() => {
                setPinned(tr.participant.identity + ':' + tr.source);
                changeLayout('focus');
              }}
            />
          ))}
      </div>
      {videoTarget &&
        createPortal(
          <div className="media-gallery-tiles">
            {shown.map((tr) => (
              <MediaTile
                key={tr.participant.identity + ':' + tr.source}
                track={tr}
                mirror={mirror}
                onPin={() => {
                  setPinned(tr.participant.identity + ':' + tr.source);
                  changeLayout('focus');
                }}
              />
            ))}
          </div>,
          videoTarget,
        )}
      <StartAudio label={t('allowAudioPlayback')} />
      {controlsTarget ? createPortal(toolbar, controlsTarget) : toolbar}
      <details
        className="media-devices"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}
      >
        <summary>{t('mediaDevices')}</summary>
        <div>
          <label>
            {t('cameraBackground')}
            <select
              value={background}
              disabled={
                !backgroundSupported || !isCameraEnabled || backgroundBusy || mediaBusy || resuming
              }
              onChange={(e) => void changeBackground(e.target.value as typeof background)}
            >
              <option value="off">{t('backgroundOff')}</option>
              <option value="blur">{t('backgroundBlur')}</option>
              <option value="replace">{t('backgroundReplace')}</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={processing}
              onChange={(event) => {
                setProcessing(event.target.checked);
                localStorage.setItem('microphone-processing', String(event.target.checked));
              }}
            />
            {t('microphoneProcessing')}
          </label>
          <DeviceSelect
            kind="audioinput"
            label={t('microphone')}
            onError={onError}
            operate={operate}
          />
          <DeviceSelect kind="videoinput" label={t('camera')} onError={onError} operate={operate} />
          {'setSinkId' in HTMLMediaElement.prototype && (
            <DeviceSelect
              kind="audiooutput"
              label={t('speaker')}
              onError={onError}
              operate={operate}
            />
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={mirror}
              onChange={(e) => {
                setMirror(e.target.checked);
                localStorage.setItem('media-mirror', String(e.target.checked));
              }}
            />
            {t('mirrorCamera')}
          </label>
          {controlsTarget && (
            <DisconnectButton onClick={onUserDisconnect}>{t('disconnectMedia')}</DisconnectButton>
          )}
        </div>
      </details>
      <RoomAudioRenderer />
    </div>
  );
}
function MediaTile({
  track,
  mirror,
  onPin,
}: {
  track: TrackReferenceOrPlaceholder;
  mirror: boolean;
  onPin: () => void;
}) {
  const { t } = useTranslation();
  const moderators = useContext(ModeratorContext);
  const video = useRef<HTMLVideoElement>(null);
  const activeSpeaker = useIsSpeaking(track.participant);
  const speaking = activeSpeaker && track.participant.isMicrophoneEnabled;
  const muted = useIsMuted(track);
  const liveTrack = track.publication?.track;
  useEffect(() => {
    const element = video.current;
    if (!element || !liveTrack) return;
    liveTrack.attach(element);
    return () => {
      liveTrack.detach(element);
    };
  }, [liveTrack]);
  const label = track.participant.name || track.participant.identity;
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((v) => v[0])
    .join('');
  return (
    <div
      className={'media-tile' + (speaking ? ' speaking' : '')}
      data-speaking={speaking}
      data-participant-id={track.participant.identity}
      data-source={track.source}
      data-audio-only={track.source === Track.Source.Camera && (!liveTrack || muted)}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted={track.participant.isLocal}
        style={{
          visibility: liveTrack && !muted ? 'visible' : 'hidden',
          transform:
            mirror && track.participant.isLocal && track.source === Track.Source.Camera
              ? 'scaleX(-1)'
              : undefined,
        }}
      />
      {(!liveTrack || muted) && (
        <span
          className="media-initials"
          style={participantAvatarStyle(
            track.participant.identity,
            moderators.has(track.participant.identity),
          )}
          aria-hidden="true"
        >
          {initials}
        </span>
      )}
      <div className="media-tile-label">
        <span
          className="media-mic-state"
          title={
            t('microphone') +
            ' · ' +
            t(track.participant.isMicrophoneEnabled ? 'mediaEnabled' : 'mediaDisabled')
          }
        >
          <ClassIcon name={track.participant.isMicrophoneEnabled ? 'mic' : 'micOff'} />
          {t(track.participant.isMicrophoneEnabled ? 'mediaEnabled' : 'mediaDisabled')}
        </span>
        <span title={label}>
          {label}
          {track.source === Track.Source.ScreenShare ? ' · ' + t('sharingScreen') : ''}
        </span>
        <button aria-label={t('pinParticipant') + ' ' + label} onClick={onPin}>
          {t('pinParticipant')}
        </button>
      </div>
    </div>
  );
}
function DeviceSelect({
  kind,
  label,
  onError,
  operate,
}: {
  kind: MediaDeviceKind;
  label: string;
  onError: (e: Error) => void;
  operate: MediaOperation;
}) {
  const { t } = useTranslation();
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    requestPermissions: false,
    onError,
  });
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={activeDeviceId}
        onChange={(e) => {
          const deviceId = e.target.value;
          void operate(async () => {
            await setActiveMediaDevice(deviceId);
          }).catch(onError);
        }}
      >
        <option value="">{t('defaultDevice')}</option>
        {devices.map((device, index) => (
          <option key={device.deviceId || index} value={device.deviceId}>
            {device.label || label + ' ' + (index + 1)}
          </option>
        ))}
      </select>
    </label>
  );
}
