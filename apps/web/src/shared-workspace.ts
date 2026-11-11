import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { useClassroomConnection } from './live';
export type SharedWorkspace = {
  kind: 'document' | 'geogebra' | 'presentation';
  documentId: string | null;
  geogebraId: string | null;
  geoPerspective: string;
  revision: number;
  updatedBy: string | null;
};
export function useSharedWorkspace(roomId: string) {
  const [workspace, setWorkspace] = useState<SharedWorkspace>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const current = useRef<SharedWorkspace | undefined>(undefined),
    version = useRef(0),
    mounted = useRef(true);
  const receive = (value: SharedWorkspace) => {
    if (!mounted.current || (current.current && value.revision < current.current.revision)) return;
    current.current = value;
    setWorkspace(value);
    setError('');
  };
  const load = async () => {
    const id = ++version.current;
    try {
      const data = await request<SharedWorkspace>(
        '/classrooms/' + roomId + '/workspace',
        undefined,
        { silent: true },
      );
      if (id === version.current) receive(data);
    } catch (e) {
      if (mounted.current && id === version.current) setError((e as Error).message);
    }
  };
  useClassroomConnection(roomId, () => void load(), ['workspace_changed']);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      version.current++;
    };
  }, [roomId]);
  const select = async (
    data: Pick<SharedWorkspace, 'kind'> &
      Partial<Pick<SharedWorkspace, 'documentId' | 'geogebraId' | 'geoPerspective'>>,
  ) => {
    setBusy(true);
    setError('');
    try {
      const next = await request<SharedWorkspace>('/classrooms/' + roomId + '/workspace', {
        ...data,
        expectedRevision: current.current?.revision ?? 0,
      });
      receive(next);
      return next;
    } catch (e) {
      await load();
      throw e;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return { workspace, busy, error, select, reload: load };
}
