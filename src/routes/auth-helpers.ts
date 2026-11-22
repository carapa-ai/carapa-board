export function requireAuth(req: any, res: any, next: any): any {
  if (!req.authUser?.id)
    return res.status(401).json({ error: 'Authentication required' });
  return next();
}
