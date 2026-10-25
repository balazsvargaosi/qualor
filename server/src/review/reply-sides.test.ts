import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient, GitHubComment } from '../scm/github/client';
import type { GitLabClient, GitLabDiscussion } from '../scm/gitlab/client';
import { ScmError } from '../scm/provider';
import type { ReplyRow } from './replies';
import { githubCommandSide, gitlabCommandSide } from './reply-sides';

/*
 * Whether the author of a command's note has the rights `qualor review` needs (6I-4): the same
 * rights a reply needs to change a finding's status, read through the same functions, and failing
 * closed. The sides are driven here by clients that answer from a list, so that every way the
 * author may be unknown is reached; the answer job's tests (reply-job.db.test.ts) run the whole
 * flow through the provider fakes.
 */

const NOTE = 41;
const ROW = {
  id: '01920000-0000-7000-8000-0000000000cc',
  noteId: NOTE,
  author: 'octocat',
} as ReplyRow;
const REF = '77';
const REPO = { owner: 'acme', repo: 'shop' };

describe('whether the author of a command on GitLab has the rights `qualor review` needs', () => {
  /** The command's discussion as GitLab lists it: the person's note, written by user `author`. */
  const discussion = (author: number, noteId = NOTE): GitLabDiscussion => ({
    id: 'abc123',
    individual_note: true,
    notes: [
      {
        id: noteId,
        body: 'qualor review',
        author: { id: author, username: `user${author}` },
        created_at: '2026-10-25T10:00:00Z',
        system: false,
      },
    ],
  });
  /** A client whose listings are `listings`, one for each read, and whose members have `levels`. */
  const client = (
    listings: { items: GitLabDiscussion[]; complete: boolean }[],
    levels: Record<number, number | null> = {},
  ) => {
    const discussions = vi.fn();
    for (const listing of listings) discussions.mockResolvedValueOnce(listing);
    const memberAccessLevel = vi.fn(async (_ref: string, userId: number) => levels[userId] ?? null);
    const stub = {
      currentUser: async () => ({ id: 1, username: 'qualor' }),
      discussions,
      memberAccessLevel,
    } as unknown as GitLabClient;
    return { stub, memberAccessLevel };
  };
  const side = (stub: GitLabClient) => gitlabCommandSide('c1', stub, REF, '12', ROW, 'abc123');

  it.each([
    [30, true],
    [40, true],
    [50, true],
    [20, false],
    [10, false],
    [null, false],
  ] as const)(
    'a member of level %s: %s, by one request for the author the note names',
    async (level, may) => {
      const { stub, memberAccessLevel } = client([{ items: [discussion(5)], complete: true }], {
        5: level,
      });
      const commandSide = side(stub);
      expect(await commandSide.read()).toEqual({ answered: null });
      expect(await commandSide.mayReview()).toBe(may);
      expect(memberAccessLevel).toHaveBeenCalledExactlyOnceWith(REF, 5);
    },
  );

  it('an author the discussion does not show has no rights, and none is asked for', async () => {
    // The discussion holds another note, and is missing from a listing cut at its page bound.
    for (const listing of [
      { items: [discussion(5, NOTE + 1)], complete: true },
      { items: [], complete: false },
    ]) {
      const { stub, memberAccessLevel } = client([listing], { 5: 30 });
      const commandSide = side(stub);
      await commandSide.read();
      expect(await commandSide.mayReview()).toBe(false);
      expect(memberAccessLevel).not.toHaveBeenCalled();
    }
    // No read at all: nobody is known.
    const { stub, memberAccessLevel } = client([], { 5: 30 });
    expect(await side(stub).mayReview()).toBe(false);
    expect(memberAccessLevel).not.toHaveBeenCalled();
  });

  it('is never the author of an earlier read: what a read does not find it does not know', async () => {
    const second = [
      // The discussion no longer holds the note; it is not listed in a listing cut at its page
      // bound; it is gone from a listing read whole.
      { items: [discussion(5, NOTE + 1)], complete: true },
      { items: [], complete: false },
      { items: [], complete: true },
    ];
    for (const listing of second) {
      const { stub, memberAccessLevel } = client(
        [{ items: [discussion(5)], complete: true }, listing],
        { 5: 30 },
      );
      const commandSide = side(stub);
      await commandSide.read();
      expect(await commandSide.mayReview()).toBe(true);
      await commandSide.read();
      expect(await commandSide.mayReview()).toBe(false);
      expect(memberAccessLevel).toHaveBeenCalledTimes(1);
    }
  });
});

describe('whether the author of a command on GitHub has the rights `qualor review` needs', () => {
  /** The command's comment on the pull request's page, written by `login` (null: an account that is gone). */
  const comment = (login: string | null, id = NOTE): GitHubComment => ({
    id,
    body: 'qualor review',
    user: login === null ? null : { login, type: 'User' },
    created_at: '2026-10-25T10:00:00Z',
  });
  type Permission = { permission: string; roleName: string | null } | null;
  /** A client whose listings are `listings`, one for each read, and whose accounts have `permissions`. */
  const client = (
    listings: { items: GitHubComment[]; complete: boolean }[],
    permissions: Record<string, Permission | Error> = {},
  ) => {
    const issueComments = vi.fn();
    for (const listing of listings) issueComments.mockResolvedValueOnce(listing);
    const repositoryPermission = vi.fn(async (login: string) => {
      const found = permissions[login] ?? null;
      if (found instanceof Error) throw found;
      return found;
    });
    const stub = {
      app: async () => ({ id: 1, slug: 'qualor' }),
      useRepository: async () => ({}),
      issueComments,
      repositoryPermission,
    } as unknown as GitHubClient;
    return { stub, repositoryPermission };
  };
  const warnings: unknown[][] = [];
  const logger = { warn: (...args: unknown[]) => void warnings.push(args) };
  const side = (stub: GitHubClient) => githubCommandSide('c1', stub, REPO, '7', ROW, logger);

  it.each([
    { name: 'write', permission: { permission: 'write', roleName: 'write' }, may: true },
    { name: 'maintain', permission: { permission: 'write', roleName: 'maintain' }, may: true },
    { name: 'admin', permission: { permission: 'admin', roleName: 'admin' }, may: true },
    { name: 'triage', permission: { permission: 'read', roleName: 'triage' }, may: true },
    {
      name: 'a custom role on write',
      permission: { permission: 'write', roleName: 'security-lead' },
      may: true,
    },
    {
      name: 'no role named, write',
      permission: { permission: 'write', roleName: null },
      may: true,
    },
    { name: 'read', permission: { permission: 'read', roleName: 'read' }, may: false },
    {
      name: 'a custom role on read',
      permission: { permission: 'read', roleName: 'auditor' },
      may: false,
    },
    { name: 'no role named, read', permission: { permission: 'read', roleName: null }, may: false },
    { name: 'none', permission: { permission: 'none', roleName: 'none' }, may: false },
    { name: 'no permission', permission: null, may: false },
  ])(
    '$name: may ask for a review is $may, by one request for the login the comment names now',
    async ({ permission, may }) => {
      // The comment's author is the login it has now, not the one the ledger recorded.
      const { stub, repositoryPermission } = client(
        [{ items: [comment('hubot')], complete: true }],
        { hubot: permission },
      );
      const commandSide = side(stub);
      expect(await commandSide.read()).toEqual({ answered: null });
      expect(await commandSide.mayReview()).toBe(may);
      expect(repositoryPermission).toHaveBeenCalledExactlyOnceWith('hubot');
    },
  );

  it('a comment the listing does not show is gone when the listing is whole; its author is unknown, with no request, when it is cut', async () => {
    const whole = client([{ items: [comment('hubot', NOTE + 1)], complete: true }], {
      hubot: { permission: 'admin', roleName: 'admin' },
    });
    const wholeSide = side(whole.stub);
    expect(await wholeSide.read()).toBeNull();
    expect(await wholeSide.mayReview()).toBe(false);
    const cut = client([{ items: [comment('hubot', NOTE + 1)], complete: false }], {
      hubot: { permission: 'admin', roleName: 'admin' },
    });
    const cutSide = side(cut.stub);
    expect(await cutSide.read()).toEqual({ answered: null });
    expect(await cutSide.mayReview()).toBe(false);
    expect(whole.repositoryPermission).not.toHaveBeenCalled();
    expect(cut.repositoryPermission).not.toHaveBeenCalled();
  });

  it('an account that is gone, a login that is missing and no read at all have no rights, and none is asked for', async () => {
    const gone = client([{ items: [comment(null)], complete: true }]);
    const goneSide = side(gone.stub);
    expect(await goneSide.read()).toEqual({ answered: null });
    expect(await goneSide.mayReview()).toBe(false);
    const unread = client([]);
    expect(await side(unread.stub).mayReview()).toBe(false);
    expect(gone.repositoryPermission).not.toHaveBeenCalled();
    expect(unread.repositoryPermission).not.toHaveBeenCalled();
  });

  it('is never the login of an earlier read: what a read does not find it does not know', async () => {
    const second = [
      // The comment is not listed in a listing cut at its page bound, is gone from a listing read
      // whole, and is there again with an account that is gone.
      { items: [comment('hubot', NOTE + 1)], complete: false },
      { items: [], complete: true },
      { items: [comment(null)], complete: true },
    ];
    for (const listing of second) {
      const { stub, repositoryPermission } = client(
        [{ items: [comment('hubot')], complete: true }, listing],
        { hubot: { permission: 'admin', roleName: 'admin' } },
      );
      const commandSide = side(stub);
      await commandSide.read();
      expect(await commandSide.mayReview()).toBe(true);
      await commandSide.read();
      expect(await commandSide.mayReview()).toBe(false);
      expect(repositoryPermission).toHaveBeenCalledTimes(1);
    }
  });

  it('a permission answer that does not parse is no permission, said in one line without its text; any other error is thrown', async () => {
    warnings.length = 0;
    const odd = client([{ items: [comment('hubot')], complete: true }], {
      hubot: new ScmError('bad_answer', 'GitHub answered something unexpected'),
    });
    const oddSide = side(odd.stub);
    await oddSide.read();
    expect(await oddSide.mayReview()).toBe(false);
    expect(warnings).toEqual([
      [{ replyId: ROW.id }, 'GitHub permission answer not understood; the command is refused'],
    ]);
    const down = client([{ items: [comment('hubot')], complete: true }], {
      hubot: new ScmError('transient', 'GitHub could not be reached'),
    });
    const downSide = side(down.stub);
    await downSide.read();
    await expect(downSide.mayReview()).rejects.toThrow('GitHub could not be reached');
  });
});
