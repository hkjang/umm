import { useEffect, useState } from 'react';
import { Badge, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { api, json } from '../api';
import { useAuth } from '../auth-context';
import { useTranslation } from '../i18n';

interface Request {
  id: string;
  requesterName: string;
  resourceType: string;
  resourceName: string;
  action: string;
  status: string;
  comment: string;
  createdAt: string;
}
/**
 * The words for a request, rather than the values it is stored as.
 *
 * This page rendered `pending` and `export · space` — internal identifiers, in
 * English, on a Korean screen. The product already has words for these: the
 * admin screen that switches the workflow on calls them 팀 공간 공유 and
 * 외부 내보내기. It was only this page that never used them.
 *
 * Written out rather than looked up in a map, because a dynamic key never
 * reaches the translation extractor and would ship untranslated — the same
 * mistake in a new place.
 */
function actionLabel(action: string, t: (key: string) => string): string {
  if (action === 'space_share') return t('팀 공간 공유');
  if (action === 'export') return t('외부 내보내기');
  return action;
}

function statusLabel(status: string, t: (key: string) => string): string {
  if (status === 'pending') return t('검토 대기');
  if (status === 'approved') return t('승인됨');
  if (status === 'rejected') return t('반려됨');
  return status;
}

export default function ApprovalsPage() {
  const { user } = useAuth();
  const { t, formatDate } = useTranslation();
  const [requests, setRequests] = useState<Request[]>([]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const load = () => api<{ requests: Request[] }>('/approvals').then((v) => setRequests(v.requests));
  useEffect(() => {
    void load();
  }, []);
  const decide = async (id: string, decision: string) => {
    await api(`/approvals/${id}/decision`, json('POST', { decision, comment: comments[id] || '' }));
    await load();
  };
  return (
    <div className="settings-page">
      <Stack maw={900} mx="auto" gap="xl">
        <div>
          <Text size="sm" fw={700} c="grape.7">
            WORKFLOW
          </Text>
          <Title order={1}>{t('검토 · 승인')}</Title>
          <Text c="dimmed" mt="xs">
            {t(
              '관리자가 승인 절차를 켠 작업만 이곳에 나타납니다. 설정하지 않은 작업에는 승인 단계가 추가되지 않습니다.',
            )}
          </Text>
        </div>
        {requests.length === 0 ? (
          <Card p="xl" withBorder radius="lg">
            <Text c="dimmed">{t('현재 검토 요청이 없습니다.')}</Text>
          </Card>
        ) : (
          requests.map((req) => (
            <Card key={req.id} p="lg" radius="lg" withBorder>
              <Group justify="space-between">
                <div>
                  <Group>
                    <Text fw={650}>{req.requesterName}</Text>
                    <Badge color={req.status === 'approved' ? 'green' : req.status === 'rejected' ? 'red' : 'yellow'}>
                      {statusLabel(req.status, t)}
                    </Badge>
                  </Group>
                  <Text mt="sm" fw={600}>
                    {actionLabel(req.action, t)}
                  </Text>
                  {/* Which space, not just that it is a space. The reviewer is
                      deciding whether this may happen to this workspace, and a
                      name is the whole of that decision. A request can outlive
                      its space, so an unnamed one says so rather than showing
                      an empty line. */}
                  <Text size="sm" c="dimmed">
                    {req.resourceName || t('이름을 확인할 수 없는 대상')}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {formatDate(req.createdAt)}
                  </Text>
                </div>
                {req.status === 'pending' && (user?.role === 'admin' || user?.role === 'team_lead') && (
                  <Stack>
                    <TextInput
                      size="sm"
                      placeholder={t('검토 의견 (선택)')}
                      value={comments[req.id] || ''}
                      onChange={(e) => setComments((v) => ({ ...v, [req.id]: e.currentTarget.value }))}
                    />
                    <Group gap="xs">
                      <Button
                        size="xs"
                        color="green"
                        leftSection={<IconCheck size={15} />}
                        onClick={() => void decide(req.id, 'approved')}
                      >
                        {t('승인')}
                      </Button>
                      <Button
                        size="xs"
                        color="red"
                        variant="light"
                        leftSection={<IconX size={15} />}
                        onClick={() => void decide(req.id, 'rejected')}
                      >
                        {t('반려')}
                      </Button>
                    </Group>
                  </Stack>
                )}
              </Group>
              {req.comment && (
                <Text mt="md" p="sm" bg="gray.0">
                  {req.comment}
                </Text>
              )}
            </Card>
          ))
        )}
      </Stack>
    </div>
  );
}
