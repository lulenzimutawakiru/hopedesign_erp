/** Screen label for stores that carry a classification. Null means the screen is unlabelled. */
export function informationClass(path: string): 'RESTRICTED' | 'CONFIDENTIAL' | 'INTERNAL' | null {
  if (path.startsWith('/people') || path.startsWith('/compliance') || path.startsWith('/security-jobs')) {
    return 'RESTRICTED';
  }
  if (
    path.startsWith('/finance')
    || path.startsWith('/admin')
    || path.startsWith('/spend')
    || path.startsWith('/buy')
  ) {
    return 'CONFIDENTIAL';
  }
  if (path.startsWith('/communication') || path.startsWith('/documents')) return 'INTERNAL';
  return null;
}
