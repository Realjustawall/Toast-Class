import { readJsonResponse, ResponseError } from './http-response';
import i18n from './i18n';
import { pushToast } from './toast';

export async function request<T>(
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal; silent?: boolean },
): Promise<T> {
  let r: Response;
  const timeout = AbortSignal.timeout(20000);
  try {
    r = await fetch('/api/v1' + path, {
      credentials: 'same-origin',
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    const msg = i18n.t('serverUnavailable');
    if (path !== '/me' && !options?.silent) pushToast(msg, 'error');
    throw new ResponseError('serverUnavailable', 0, msg);
  }
  try {
    return await readJsonResponse<T>(r);
  } catch (error) {
    if (error instanceof ResponseError) {
      const known: Record<string, string> = {
        'Public chat is disabled for this classroom': 'chatPublicDisabled',
        'Private chat is disabled for this classroom': 'chatPrivateDisabled',
        'Chat permissions changed; refresh before saving': 'chatPolicyConflict',
        'Only a moderator can change chat permissions': 'chatPolicyModeratorOnly',
        'Choose another participant': 'chatChooseParticipant',
        'Private message not found': 'chatPrivateMissing',
        'Downloads are disabled by the presenter': 'downloadDisabledNotice',
        'Only the presenter can change download access': 'presenterOnly',
        'Download permissions changed; refresh before saving': 'downloadAccessConflict',
        'Download target not found': 'downloadTargetMissing',
        'Preferences changed; reload before saving': 'preferencesConflict',
        'Invalid credentials': 'invalidCredentials',
        'Current password is incorrect': 'invalidCurrentPassword',
        'Choose a different password': 'chooseDifferentPassword',
        Conflict: 'accountConflict',
        'Already exists': path === '/auth/register' ? 'accountConflict' : 'resourceExists',
        'Internal server error': 'serverUnavailable',
        'Registration is closed': 'registrationClosed',
        'Invalid input': 'invalidForm',
        'No eligible students are online': 'noEligibleStudents',
        'This feature is disabled by the platform administrator': 'platformFeatureDisabled',
        'Organization creation is disabled by the platform administrator': 'platformOrgDisabled',
        'Message exceeds the platform length limit': 'platformMessageTooLong',
        'Only the presenter can change the shared workspace': 'presenterOnly',
        'Only the presenter can add a page': 'presenterOnly',
        'Shared workspace changed; refresh before switching': 'sharedWorkspaceConflict',
        'Classroom locks changed; refresh before saving': 'classLocksConflict',
        'Participant permissions changed; refresh before saving': 'participantLocksConflict',
        'Platform settings changed; refresh before saving': 'platformSettingsConflict',
        'Sign in required': 'signInRequired',
        'Session expired': 'signInRequired',
        'Classroom is locked by moderator': 'classroomLockedError',
        'Chat is disabled by moderator': 'permChatDisabledNotice',
        'Image messages are disabled by moderator': 'chatImagesDenied',
        'Image not available': 'chatImageUnavailable',
        'Chat category already exists': 'chatCategoryDuplicate',
        'Chat category limit reached': 'chatCategoryLimit',
        'Invalid GeoGebra file': 'geoInvalidFile',
        'GeoGebra worksheet changed': 'geoConflict',
        'GeoGebra worksheet limit reached': 'geoWorksheetLimit',
        'Hand raise is disabled by moderator': 'permHandDisabled',
        'Removed from classroom by moderator': 'errRemovedFromClassroom',
        'No active session': 'errNoActiveSession',
        'A teacher must start the session first': 'errTeacherMustStartSession',
        'Media service is not configured': 'errMediaNotConfigured',
        'Media access blocked by moderator': 'errMediaBlockedByModerator',
        'Board is read only': 'errBoardReadOnly',
        'Document is read only': 'errDocumentReadOnly',
        'Not found': 'errNotFound',
        Forbidden: 'errForbidden',
        'Only an owner can moderate another owner': 'errOwnerModerateOwner',
        'Cannot change owner role': 'errCannotChangeOwnerRole',
        'Poll is closed': 'errPollClosed',
        'Timer not started': 'errTimerNotStarted',
      };
      error.message = i18n.t(
        known[error.message] ?? (error.message === error.code ? error.code : ''),
        { defaultValue: error.message },
      );
      if (path !== '/me' && !options?.silent) {
        pushToast(error.message, 'error');
      }
    }
    throw error;
  }
}
