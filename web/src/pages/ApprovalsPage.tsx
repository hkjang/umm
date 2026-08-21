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
  action: string;
  status: string;
  comment: string;
  createdAt: string;
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
    <main className="settings-page">
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
                      {req.status}
                    </Badge>
                  </Group>
                  <Text mt="sm">
                    {req.action} · {req.resourceType}
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
    </main>
  );
}
