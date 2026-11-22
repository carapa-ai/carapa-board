import { useState, useEffect, useRef } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchUsers,
  createUserAccount,
  updateUserAccount,
  deleteUserAccount,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  Users,
  Plus,
  RefreshCw,
  Shield,
  Clock,
  AlertCircle,
  UserPlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { shortEntityId } from '@/lib/short-id';
import { PageHeader } from '@/components/layout/page-header';
import { queryKeys } from '@/lib/query-keys';

interface UserRow {
  id: string;
  username: string;
  role: 'admin' | 'user';
  created_at: string;
  disabled?: boolean;
}

/** Stable id so a repeated submit replaces (and dismisses) the previous error. */
const CREATE_USER_ERROR_TOAST_ID = 'users-create-user-error';

export function UsersPage() {
  const queryClient = useQueryClient();
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const currentUserId = useAuth((s) => s.user?.id ?? null);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);

  // Add User state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');

  const {
    data: usersData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: queryKeys.admin.users,
    queryFn: fetchUsers,
    refetchInterval: 15000,
    enabled: isAdmin,
  });

  const createUserMutation = useMutation({
    mutationFn: createUserAccount,
    onSuccess: () => {
      toast.success('User account created successfully!');
      setUsername('');
      setPassword('');
      setRole('user');
      setIsAddOpen(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users });
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to create user account', {
        id: CREATE_USER_ERROR_TOAST_ID,
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof updateUserAccount>[1];
    }) => updateUserAccount(id, data),
    onSuccess: () => {
      toast.success('User updated');
      setEditTarget(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users });
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to update user');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUserAccount(id),
    onSuccess: () => {
      toast.success('User deleted');
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users });
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to delete user');
    },
  });

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      toast.error('Both username and password are required.');
      return;
    }
    // Clear the previous failure (e.g. "Username already taken") so the next
    // submit starts from a clean slate.
    toast.dismiss(CREATE_USER_ERROR_TOAST_ID);
    createUserMutation.mutate({ username, password, role });
  };

  const filteredUsers = (usersData as UserRow[] | undefined)?.filter((u) =>
    u.username.toLowerCase().includes(search.toLowerCase()),
  );

  if (!isAdmin) {
    return (
      <div className="flex-1 h-full flex flex-col items-center justify-center p-6 text-center">
        <Shield className="size-10 text-muted-foreground/40 mb-3" />
        <h2 className="text-base font-bold">Admin access required</h2>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Only administrators can view and manage user accounts.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full flex flex-col min-h-0 bg-gradient-to-br from-background via-background/95 to-background/90 select-none">
      <PageHeader
        className="border-border/60 bg-background/60 backdrop-blur-xl"
        icon={
          <div className="p-2.5 bg-primary/10 rounded-xl shrink-0 border border-primary/20">
            <Users className="size-5 text-primary" />
          </div>
        }
        title={
          <>
            <span className="text-base sm:text-lg font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
              Users & Roles
            </span>
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4.5 bg-primary/5 text-primary border-primary/20 font-bold tracking-wider"
            >
              ADMIN
            </Badge>
          </>
        }
        subtitle={
          <span className="text-xs text-muted-foreground/80 truncate">
            Manage system access, create user accounts, and control
            organizational roles.
          </span>
        }
      >
        <SearchInput
          aria-label="Filter users"
          placeholder="Filter users..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          wrapperClassName="flex-1 sm:flex-initial sm:w-64"
        />

        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="gap-1.5 shadow-lg shadow-primary/20 hover:shadow-primary/30 active:scale-[0.97] transition-all h-9 shrink-0 px-3 bg-gradient-to-r from-primary to-primary/90 text-primary-foreground font-bold rounded-lg select-none">
              <UserPlus className="size-4 shrink-0" />
              <span>Create User</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[400px] border border-border/80 bg-background/95 backdrop-blur-md rounded-xl select-none">
            <form onSubmit={handleCreateUser}>
              <DialogHeader>
                <DialogTitle className="text-base font-extrabold flex items-center gap-2 tracking-tight">
                  <Shield className="size-4.5 text-primary" />
                  <span>Register New Account</span>
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground/80 leading-normal">
                  Set up a new credentialed user profile. This user will receive
                  their own isolated board and projects.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3.5 py-4 select-none">
                <div className="grid gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground/90">
                    Username
                  </label>
                  <Input
                    placeholder="Enter a username..."
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground/90">
                    Password
                  </label>
                  <Input
                    type="password"
                    placeholder="Create a strong password..."
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground/90">
                    Role
                  </label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={role === 'user' ? 'default' : 'outline'}
                      onClick={() => setRole('user')}
                      className="flex-1 h-9 select-none text-xs rounded-lg transition-all"
                    >
                      Standard User
                    </Button>
                    <Button
                      type="button"
                      variant={role === 'admin' ? 'default' : 'outline'}
                      onClick={() => setRole('admin')}
                      className="flex-1 h-9 select-none text-xs rounded-lg transition-all"
                    >
                      Administrator
                    </Button>
                  </div>
                </div>
              </div>
              <DialogFooter className="gap-2 select-none">
                <Button
                  type="submit"
                  disabled={
                    createUserMutation.isPending || !username || !password
                  }
                  className="w-full gap-2 transition-all h-9.5 bg-gradient-to-r from-primary to-primary/90 text-primary-foreground font-bold rounded-lg shadow-md shadow-primary/10 select-none"
                >
                  {createUserMutation.isPending ? (
                    <RefreshCw className="size-4 animate-spin mr-1" />
                  ) : (
                    <Plus className="size-4 mr-1" />
                  )}
                  Save New User
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </PageHeader>

      <ScrollArea className="flex-1">
        <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full select-none">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <RefreshCw className="size-8 animate-spin mb-3 opacity-50 text-primary" />
              <p className="text-sm font-semibold tracking-wide text-foreground/80">
                Loading system users...
              </p>
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-64 border border-dashed border-destructive/20 rounded-xl bg-destructive/5 p-6">
              <AlertCircle className="size-10 text-destructive mb-3 opacity-80 animate-pulse" />
              <h3 className="text-base font-bold text-destructive">
                Could not load users
              </h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-md text-center">
                Access is restricted to administrator profiles. Please verify
                your authentication level or try again.
              </p>
            </div>
          ) : filteredUsers?.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-border/60 rounded-xl bg-accent/20 select-none">
              <Users className="size-10 text-muted-foreground mb-3 opacity-30" />
              <h3 className="text-base font-bold text-foreground">
                No matching users found
              </h3>
              <p className="text-xs text-muted-foreground mb-4">
                Click "Create User" to get started.
              </p>
              <Button
                variant="outline"
                className="h-8.5 rounded-lg select-none text-xs"
                onClick={() => setIsAddOpen(true)}
              >
                Register first user
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5 select-none">
              {filteredUsers?.map((u) => {
                const isSelf = u.id === currentUserId;
                return (
                  <Card
                    key={u.id}
                    className="group relative border-border/50 bg-background/30 hover:bg-background/60 transition-all hover:border-primary/40 hover:shadow-xl hover:shadow-primary/5 hover:-translate-y-1 overflow-hidden select-none backdrop-blur-sm rounded-xl"
                  >
                    <CardContent className="p-4.5 flex flex-col justify-between h-full gap-3">
                      <div className="flex items-start justify-between gap-3 min-w-0">
                        <div className="flex items-center gap-3.5 min-w-0">
                          <div className="p-2.5 bg-primary/5 rounded-xl group-hover:bg-primary/10 transition-colors shrink-0 border border-primary/10 group-hover:border-primary/20">
                            <Users className="size-4.5 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="text-sm font-extrabold truncate group-hover:text-primary transition-colors leading-tight tracking-tight select-none">
                              {u.username}
                              {isSelf && (
                                <span className="ml-1 text-[10px] font-medium text-muted-foreground">
                                  (you)
                                </span>
                              )}
                            </CardTitle>
                            <div className="flex items-center gap-1.5 mt-1 select-none flex-wrap">
                              <Badge
                                variant={
                                  u.role === 'admin' ? 'default' : 'secondary'
                                }
                                className="text-[9px] font-extrabold tracking-wider px-1.5 py-0 h-4.5 select-none uppercase"
                              >
                                {u.role}
                              </Badge>
                              <Badge
                                variant="outline"
                                title={u.id}
                                className="text-[9px] font-mono tracking-wider px-1.5 py-0 h-4.5 select-none border-muted-foreground/20 text-muted-foreground/80"
                              >
                                ID: {shortEntityId(u.id)}
                              </Badge>
                              {u.disabled && (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] font-bold tracking-wider px-1.5 py-0 h-4.5 select-none border-amber-500/30 text-amber-800 dark:text-amber-500 bg-amber-500/5 uppercase"
                                >
                                  Disabled
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 max-md:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            title="Edit user"
                            aria-label={`Edit user ${u.username}`}
                            onClick={() => setEditTarget(u)}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            title={
                              isSelf
                                ? 'Cannot delete your own account'
                                : 'Delete user'
                            }
                            aria-label={`Delete user ${u.username}`}
                            disabled={isSelf}
                            onClick={() => setDeleteTarget(u)}
                          >
                            <Trash2 className="size-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>

                      <div className="flex items-center justify-between border-t border-border/30 pt-3 mt-1 select-none">
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground/70">
                          <Clock className="size-3 shrink-0" />
                          <span>
                            Registered:{' '}
                            {new Date(u.created_at).toLocaleDateString(
                              undefined,
                              {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              },
                            )}
                          </span>
                        </div>
                        {!u.disabled && (
                          <Badge
                            variant="outline"
                            className="px-1 py-0 h-4.5 text-[9px] font-semibold border-emerald-500/20 text-emerald-700 dark:text-emerald-500 bg-emerald-500/5 select-none"
                          >
                            Active
                          </Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>

      <EditUserDialog
        target={editTarget}
        currentUserId={currentUserId}
        onClose={() => setEditTarget(null)}
        onSubmit={(data) =>
          editTarget && updateMutation.mutate({ id: editTarget.id, data })
        }
        isPending={updateMutation.isPending}
      />

      <DeleteUserDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

function EditUserDialog({
  target,
  currentUserId,
  onClose,
  onSubmit,
  isPending,
}: {
  target: UserRow | null;
  currentUserId: string | null;
  onClose: () => void;
  onSubmit: (data: {
    role?: 'admin' | 'user';
    password?: string;
    disabled?: boolean;
  }) => void;
  isPending: boolean;
}) {
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [password, setPassword] = useState('');
  const [disabled, setDisabled] = useState(false);

  // Reset local state whenever the dialog opens for a different user.
  useSyncOnTargetChange(target?.id ?? null, () => {
    if (target) {
      setRole(target.role);
      setDisabled(!!target.disabled);
      setPassword('');
    }
  });

  if (!target) return null;
  const isSelf = target.id === currentUserId;

  const submit = () => {
    const data: {
      role?: 'admin' | 'user';
      password?: string;
      disabled?: boolean;
    } = {};
    if (role !== target.role) data.role = role;
    if (password.trim().length > 0) data.password = password;
    if (disabled !== !!target.disabled) data.disabled = disabled;
    if (Object.keys(data).length === 0) {
      toast.info('No changes to save');
      return;
    }
    onSubmit(data);
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4 text-primary" />
            Edit user — {target.username}
          </DialogTitle>
          <DialogDescription>
            Change the role, reset the password, or disable the account.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <label className="text-xs font-bold text-muted-foreground/90">
              Role
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={role === 'user' ? 'default' : 'outline'}
                onClick={() => setRole('user')}
                disabled={isSelf}
                className="flex-1 h-9 text-xs rounded-lg"
              >
                Standard User
              </Button>
              <Button
                type="button"
                variant={role === 'admin' ? 'default' : 'outline'}
                onClick={() => setRole('admin')}
                className="flex-1 h-9 text-xs rounded-lg"
              >
                Administrator
              </Button>
            </div>
            {isSelf && (
              <p className="text-[10px] text-muted-foreground">
                You cannot demote your own account.
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs font-bold text-muted-foreground/90">
              Reset password (optional)
            </label>
            <Input
              type="password"
              placeholder="Leave blank to keep existing password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
            <div>
              <div className="text-xs font-bold">Disable account</div>
              <p className="text-[10px] text-muted-foreground">
                Disabled users cannot log in and lose access immediately.
              </p>
            </div>
            <Button
              type="button"
              variant={disabled ? 'default' : 'outline'}
              onClick={() => setDisabled((d) => !d)}
              disabled={isSelf}
              className="h-8 text-xs rounded-lg min-w-20"
            >
              {disabled ? 'Disabled' : 'Active'}
            </Button>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isPending ? (
              <RefreshCw className="size-4 animate-spin mr-1.5" />
            ) : null}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserDialog({
  target,
  onClose,
  onConfirm,
  isPending,
}: {
  target: UserRow | null;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="size-4" />
            Delete user
          </DialogTitle>
          <DialogDescription>
            This will permanently delete{' '}
            <span className="font-semibold text-foreground">
              {target?.username}
            </span>{' '}
            and remove them from every project, knowledge base, and shared
            conversation. Their personal workspace folder is left in place.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? (
              <RefreshCw className="size-4 animate-spin mr-1.5" />
            ) : null}
            Delete user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Sync local edit-form state when the dialog target changes.
function useSyncOnTargetChange(id: string | null, fn: () => void): void {
  const lastId = useRef<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (id !== lastId.current) {
      lastId.current = id;
      if (id) fnRef.current();
    }
  }, [id]);
}

export const Route = createFileRoute('/users')({
  component: UsersPage,
});
