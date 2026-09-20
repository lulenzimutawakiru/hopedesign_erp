/**
 * Company Mailing System - route dispatcher.
 *
 * Mirrors the Service Desk dispatcher: it only parses the route and picks a
 * screen. Every screen is its own module, so this file never grows into a
 * second monolith.
 */
import { navigate } from '../../router';
import { Nothing, num } from './mailShared';
import MailList from './MailList';
import MailReading from './MailReading';
import MailComposer from './MailComposer';
import MailApprovals from './MailApprovals';
import MailOutbox from './MailOutbox';
import MailMailboxes from './MailMailboxes';
import MailMailboxDetail from './MailMailboxDetail';
import MailSettings from './MailSettings';

interface Parsed {
  view: string;
  sub: string | null;
}

function parseMail(path: string): Parsed {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'communication' || parts[1] !== 'mail') {
    return { view: '', sub: null };
  }
  return { view: parts[2] ?? '', sub: parts[3] ?? null };
}

function MissingRecord({ what }: { what: string }) {
  return (
    <div className="page">
      <div className="page-head">
        <p className="mod-kicker" data-mod="com">
          Company mail
        </p>
        <h1>Not found</h1>
      </div>
      <Nothing
        text={'That ' + what + ' reference is missing or invalid.'}
        action="Back to inbox"
        onAction={() => navigate('/communication/mail')}
      />
    </div>
  );
}

export default function MailWorkspace({ path }: { path: string }) {
  const { view, sub } = parseMail(path);
  const id = num(sub);
  const okId = id > 0;

  switch (view) {
    case '':
    case 'inbox':
      return <MailList folder="INBOX" />;
    case 'drafts':
      return <MailList folder="DRAFTS" />;
    case 'sent':
      return <MailList folder="SENT" />;
    case 'scheduled':
      return <MailList folder="SCHEDULED" />;
    case 'archive':
      return <MailList folder="ARCHIVE" />;
    case 'spam':
      return <MailList folder="SPAM" />;
    case 'trash':
      return <MailList folder="TRASH" />;
    case 'message':
      return okId ? <MailReading id={id} /> : <MissingRecord what="message" />;
    case 'compose':
      return <MailComposer draftId={okId ? id : null} />;
    case 'approvals':
      return <MailApprovals />;
    case 'outbox':
      return <MailOutbox />;
    case 'mailboxes':
      if (sub === null) return <MailMailboxes />;
      return okId ? <MailMailboxDetail id={id} /> : <MissingRecord what="mailbox" />;
    case 'settings':
      return <MailSettings />;
    default:
      return <MissingRecord what="mail page" />;
  }
}