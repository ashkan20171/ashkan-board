import { useEffect, useMemo, useState } from 'react';
import { AtSign, MessageSquare, Plus, Trash2, X, FlaskConical, Bold, Italic, List, Heading2, Code, Eye, Pencil, FileText } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { canMoveToDone, columns, projects, workspaceMembers } from '../model';
import { api } from '../api/client';

function formatCommentDate(value, locale) {
  return new Intl.DateTimeFormat(locale === 'fa' ? 'fa-IR-u-ca-persian' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function TaskDialog({ task, isExisting, onClose, onSave, onDelete, availableTasks = [], workspaceId, currentUser, members = [], liveRevision = 0 }) {
  const { locale, t } = useLanguage();
  const [title, setTitle] = useState(task.title || '');
  const [description, setDescription] = useState(task.description || '');
  const [priority, setPriority] = useState(task.priority || 'Medium');
  const [type, setType] = useState(task.type || 'task');
  const [status, setStatus] = useState(task.status || 'backlog');
  const [dueDate, setDueDate] = useState(task.dueDate || '');
  const [assigneeId, setAssigneeId] = useState(task.assigneeId || 'ashkan');
  const [projectId, setProjectId] = useState(task.projectId || 'core');
  const [dependsOn, setDependsOn] = useState(task.dependsOn || '');
  const [recurrence, setRecurrence] = useState(task.recurrence || 'none');
  const [estimateHours, setEstimateHours] = useState(task.estimateHours || 0);
  const [timeSpentHours, setTimeSpentHours] = useState(task.timeSpentHours || 0);
  const [tests, setTests] = useState(task.tests || []);
  const [tagsInput, setTagsInput] = useState((task.tags || []).join(', '));
  const [comments, setComments] = useState(task.comments || []);
  const [commentError, setCommentError] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [descriptionMode, setDescriptionMode] = useState('write');
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [commentBusy, setCommentBusy] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [mentionId, setMentionId] = useState('');
  const [newTest, setNewTest] = useState('');
  const [error, setError] = useState('');
  const visibleComments = useMemo(() => [...comments].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)), [comments]);

  useEffect(() => {
    if (!isExisting || !workspaceId) return undefined;
    let active = true;
    const loadComments = async () => { try { const result = await api.comments(workspaceId, task.id); if (active) { setComments(result.comments || []); setCommentError(''); } } catch (error) { if (active) setCommentError(error.message); } };
    const loadAttachments = async () => { try { const result = await api.attachments(workspaceId, task.id); if (active) setAttachments(result.attachments || []); } catch (error) { if (active) setAttachmentError(error.message); } };
    loadComments(); loadAttachments(); const interval = window.setInterval(() => { loadComments(); loadAttachments(); }, 30000);
    return () => { active = false; window.clearInterval(interval); };
  }, [isExisting, workspaceId, task.id, liveRevision]);

  useEffect(() => {
    if (!previewAttachment) return undefined;
    let active = true; let objectUrl = '';
    api.downloadAttachment(workspaceId, task.id, previewAttachment.id, true).then((blob) => { if (!active) return; objectUrl = URL.createObjectURL(blob); setPreviewUrl(objectUrl); }).catch((error) => { if (active) setAttachmentError(error.message); setPreviewAttachment(null); }).finally(() => { if (active) setPreviewBusy(false); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [previewAttachment, workspaceId, task.id]);

  useEffect(() => {
    const handleKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function uploadAttachment(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || !isExisting || attachmentBusy) return;
    if (file.size > 5 * 1024 * 1024) { setAttachmentError(locale === 'fa' ? 'حداکثر اندازه فایل ۵ مگابایت است.' : 'Maximum file size is 5 MB.'); return; }
    setAttachmentBusy(true); setAttachmentError('');
    try { const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); const result = await api.uploadAttachment(workspaceId, task.id, { name: file.name, mimeType: file.type || 'application/octet-stream', data }); setAttachments((current) => [...current, result.attachment]); }
    catch (uploadError) { setAttachmentError(uploadError.message); } finally { setAttachmentBusy(false); }
  }
  function insertDescription(before, after = before) { const field = document.getElementById('task-description'); if (!field) return; const start = field.selectionStart; const end = field.selectionEnd; const selected = description.slice(start, end); const next = `${description.slice(0, start)}${before}${selected || (before === after ? (before === '- ' ? 'مورد فهرست' : 'متن') : 'متن')}${after}${description.slice(end)}`; setDescription(next); requestAnimationFrame(() => { field.focus(); const cursor = start + before.length + (selected || (before === after ? (before === '- ' ? 'مورد فهرست' : 'متن') : 'متن')).length; field.setSelectionRange(cursor, cursor); }); }
  async function downloadAttachment(item) { try { const blob = await api.downloadAttachment(workspaceId, task.id, item.id); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.name; anchor.click(); URL.revokeObjectURL(url); } catch (downloadError) { setAttachmentError(downloadError.message); } }
  async function removeAttachment(item) { try { await api.deleteAttachment(workspaceId, task.id, item.id); setAttachments((current) => current.filter((entry) => entry.id !== item.id)); } catch (removeError) { setAttachmentError(removeError.message); } }

  async function addComment() {
    const body = newComment.trim();
    if (!body || !isExisting || commentBusy) return;
    setCommentBusy(true); setCommentError('');
    try {
      const result = await api.createComment(workspaceId, task.id, { body, mentions: mentionId ? [mentionId] : [] });
      setComments((current) => [...current, result.comment]); setNewComment(''); setMentionId('');
    } catch (error) { setCommentError(error.message); }
    finally { setCommentBusy(false); }
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (!title.trim()) { setError(t('requiredTitle')); return; }
    const updated = { ...task, title: title.trim(), description: description.trim(), priority, type, status, dueDate, assigneeId, projectId, dependsOn, recurrence, estimateHours: Math.max(0, Number(estimateHours) || 0), timeSpentHours: Math.max(0, Number(timeSpentHours) || 0), tests, tags: [...new Set(tagsInput.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12), updatedAt: new Date().toISOString() };
    if (status === 'done' && !canMoveToDone(updated)) { setError(t('qaGate')); return; }
    onSave(updated);
  }

  function addTestCase() {
    const clean = newTest.trim();
    if (!clean) return;
    setTests((current) => [...current, { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, title: clean, passed: false }]);
    setNewTest('');
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="task-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header className="dialog-header">
          <div><span className="eyebrow">{isExisting ? t('editTask') : t('newTask')} · {task.id}</span><h2 id="dialog-title">{title || t('untitled')}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')}><X size={18} /></button>
        </header>
        <form onSubmit={handleSubmit}>
          <label className="field"><span>{t('title')}</span><input autoFocus maxLength={120} value={title} onChange={(event) => { setTitle(event.target.value); setError(''); }} placeholder={t('titlePlaceholder')} required /></label>
          <section className="field description-editor"><div className="description-editor-heading"><span>{t('description')}</span><div className="editor-tabs"><button type="button" className={descriptionMode === 'write' ? 'active' : ''} onClick={() => setDescriptionMode('write')}><Pencil size={13}/>{locale === 'fa' ? 'ویرایش' : 'Write'}</button><button type="button" className={descriptionMode === 'preview' ? 'active' : ''} onClick={() => setDescriptionMode('preview')}><Eye size={13}/>{locale === 'fa' ? 'پیش‌نمایش' : 'Preview'}</button></div></div>{descriptionMode === 'write' ? <><div className="editor-toolbar"><button type="button" title="Bold" onClick={() => insertDescription('**')}><Bold size={15}/></button><button type="button" title="Italic" onClick={() => insertDescription('*')}><Italic size={15}/></button><button type="button" title="Heading" onClick={() => insertDescription('## ', '')}><Heading2 size={15}/></button><button type="button" title="List" onClick={() => insertDescription('- ', '')}><List size={15}/></button><button type="button" title="Code" onClick={() => insertDescription('`')}><Code size={15}/></button></div><textarea id="task-description" rows={5} maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('descriptionHint')} /></> : <div className="markdown-preview">{renderDescription(description, locale)}</div>}<small className="editor-hint">{locale === 'fa' ? 'قالب‌بندی Markdown پشتیبانی می‌شود؛ HTML خام اجرا نمی‌شود.' : 'Markdown formatting is supported; raw HTML is never executed.'}</small></section>
          <div className="form-grid">
            <label className="field"><span>{t('priority')}</span><select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="High">{t('high')}</option><option value="Medium">{t('medium')}</option><option value="Low">{t('low')}</option></select></label>
            <label className="field"><span>{t('type')}</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="task">{t('task')}</option><option value="bug">{t('bug')}</option></select></label>
            <label className="field"><span>{t('status')}</span><select value={status} onChange={(event) => setStatus(event.target.value)}>{columns.map((column) => <option key={column.id} value={column.id}>{t(column.label)}</option>)}</select></label>
            <label className="field"><span>{t('dueDate')}</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
            <label className="field"><span>{t('project')}</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label className="field"><span>{t('assignee')}</span><select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>{workspaceMembers.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.role}</option>)}</select></label>
            <label className="field"><span>{t('dependency')}</span><select value={dependsOn} onChange={(event) => setDependsOn(event.target.value)}><option value="">{t('noDependency')}</option>{availableTasks.filter((item) => item.id !== task.id).map((item) => <option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}</select></label>
            <label className="field"><span>{t('recurrence')}</span><select value={recurrence} onChange={(event) => setRecurrence(event.target.value)}><option value="none">{t('noRecurrence')}</option><option value="daily">{t('daily')}</option><option value="weekly">{t('weekly')}</option><option value="monthly">{t('monthly')}</option></select></label>
            <label className="field"><span>{t('estimateHours')}</span><input type="number" min="0" max="10000" step="0.25" value={estimateHours} onChange={(event) => setEstimateHours(event.target.value)} /></label>
            <label className="field"><span>{t('timeSpentHours')}</span><input type="number" min="0" max="10000" step="0.25" value={timeSpentHours} onChange={(event) => setTimeSpentHours(event.target.value)} /></label>
          </div>
          <label className="field"><span>{t('tags')}</span><input value={tagsInput} maxLength={240} onChange={(event) => setTagsInput(event.target.value)} placeholder={t('tagsHint')} /><small>{t('tagsHelp')}</small></label>
          <section className="test-section">
            <div className="tests-heading"><div><h3><FlaskConical size={16} /> {t('acceptance')}</h3><small>{t('testHint')}</small></div><span className="test-count">{tests.filter((item) => item.passed).length}/{tests.length}</span></div>
            <div className="test-add"><input value={newTest} maxLength={240} onChange={(event) => setNewTest(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTestCase(); } }} placeholder={t('testPlaceholder')} /><button type="button" className="secondary-button" onClick={addTestCase}><Plus size={16} />{t('add')}</button></div>
            {tests.length ? <ul className="test-list">{tests.map((test) => <li key={test.id} className="test-item"><label className="checkbox-label"><input type="checkbox" checked={test.passed} onChange={() => setTests((current) => current.map((item) => item.id === test.id ? { ...item, passed: !item.passed } : item))} /><span className={test.passed ? 'passed' : ''}>{test.title}</span></label><button type="button" className="icon-button danger-quiet" onClick={() => setTests((current) => current.filter((item) => item.id !== test.id))} aria-label={t('removeTest')}><Trash2 size={14} /></button></li>)}</ul> : <p className="empty-tests">{t('noTests')}</p>}
            <p className="gate-hint">{t('moveTip')}</p>
          </section>
          <section className="comments-section attachment-section">
            <div className="comments-heading"><div><h3>{locale === 'fa' ? 'پیوست‌ها' : 'Attachments'}</h3><small>{locale === 'fa' ? 'فایل‌های مرتبط با این وظیفه' : 'Files related to this task · max 5 MB each'}</small></div><span className="test-count">{attachments.length}</span></div>
            {attachments.map((item) => <div className="attachment-row" key={item.id}><span><strong>{item.name}</strong><small>{(item.size / 1024).toFixed(0)} KB</small></span><div>{(item.mimeType?.startsWith('image/') || item.mimeType === 'application/pdf') && <button type="button" className="text-button" onClick={() => { setPreviewUrl(''); setPreviewBusy(true); setPreviewAttachment(item); }}>{locale === 'fa' ? 'پیش‌نمایش' : 'Preview'}</button>}<button type="button" className="text-button" onClick={() => downloadAttachment(item)}>{locale === 'fa' ? 'دریافت' : 'Download'}</button><button type="button" className="icon-button danger-quiet" onClick={() => removeAttachment(item)} aria-label="Delete attachment"><Trash2 size={14}/></button></div></div>)}
            {isExisting && <label className="attachment-upload"><Plus size={15}/>{attachmentBusy ? (locale === 'fa' ? 'در حال بارگذاری…' : 'Uploading…') : (locale === 'fa' ? 'افزودن فایل' : 'Attach file')}<input type="file" accept="application/pdf,image/png,image/jpeg,image/webp,text/plain,text/csv" onChange={uploadAttachment} disabled={attachmentBusy} hidden /></label>}
            {attachmentError && <p className="form-error" role="alert">{attachmentError}</p>}
          </section>
          <section className="comments-section">
            <div className="comments-heading"><div><h3><MessageSquare size={16} /> {t('comments')}</h3><small>{t('commentsHint')}</small></div><span className="test-count">{comments.length}</span></div>
            {visibleComments.length ? <div className="comment-list">{visibleComments.map((comment) => { const authorName = comment.author?.name || members.find((member) => member.userId === comment.authorId)?.user?.name || workspaceMembers.find((member) => member.id === comment.authorId)?.name || 'Member'; return <article className="comment-item" key={comment.id}><div className="comment-avatar avatar avatar-blue">{authorName.slice(0, 1).toUpperCase()}</div><div className="comment-body"><div className="comment-meta"><strong>{authorName}</strong><time>{formatCommentDate(comment.createdAt, locale)}</time></div><p>{comment.body}</p>{comment.mentions?.length > 0 && <span className="mention-note">{t('mentioned')}: {comment.mentions.map((id) => members.find((member) => member.userId === id)?.user?.name || workspaceMembers.find((member) => member.id === id)?.name).filter(Boolean).join(', ')}</span>}</div></article>; })}</div> : <p className="empty-tests">{t('noComments')}</p>}
            {commentError && <p className="form-error" role="alert">{commentError}</p>}
            {!isExisting && <p className="empty-tests">{locale === 'fa' ? 'پس از ذخیره وظیفه می‌توانید نظر ثبت کنید.' : 'Save the task before adding comments.'}</p>}
            <div className="comment-compose"><textarea rows={2} maxLength={500} value={newComment} onChange={(event) => setNewComment(event.target.value)} placeholder={t('commentPlaceholder')} /><div className="comment-compose-actions"><label className="mention-select"><AtSign size={14} /><select value={mentionId} onChange={(event) => setMentionId(event.target.value)} aria-label={t('mention')}><option value="">{t('mention')}</option>{(members.length ? members.filter((member) => member.userId !== currentUser?.id).map((member) => ({ id: member.userId, name: member.user?.name || member.user?.email })) : workspaceMembers.filter((member) => member.id !== 'ashkan')).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><button type="button" className="secondary-button" onClick={addComment} disabled={!isExisting || commentBusy || !newComment.trim()}><MessageSquare size={15} />{t('addComment')}</button></div></div>
          </section>
          {error && <div className="form-error" role="alert">{error}</div>}
          <footer className="dialog-actions">
            {isExisting && <button type="button" className="danger-button" onClick={() => { if (window.confirm(t('confirmDelete'))) onDelete(task.id); }}><Trash2 size={16} />{t('delete')}</button>}
            <div className="action-group"><button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button><button type="submit" className="primary-button">{t('save')}</button></div>
          </footer>
        </form>
      </section>
      {previewAttachment && <div className="preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setPreviewAttachment(null); setPreviewBusy(false); } }}><section className="attachment-preview-modal" role="dialog" aria-modal="true" aria-label={previewAttachment.name}><header><div><FileText size={17}/><strong>{previewAttachment.name}</strong></div><button type="button" className="icon-button" onClick={() => { setPreviewAttachment(null); setPreviewBusy(false); }} aria-label={t('close')}><X size={17}/></button></header>{previewBusy ? <p>{locale === 'fa' ? 'در حال بارگذاری پیش‌نمایش…' : 'Loading preview…'}</p> : previewUrl && (previewAttachment.mimeType?.startsWith('image/') ? <img src={previewUrl} alt={previewAttachment.name}/> : <iframe title={previewAttachment.name} src={previewUrl}/>)}</section></div>}
    </div>
  );
}

function renderDescription(value, locale) {
  if (!value.trim()) return <p className="preview-empty">{locale === 'fa' ? 'هنوز توضیحی نوشته نشده است.' : 'Nothing to preview yet.'}</p>;
  const inline = (line, key) => { const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g); return <p key={key}>{parts.map((part, index) => part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2,-2)}</strong> : part.startsWith('*') && part.endsWith('*') ? <em key={index}>{part.slice(1,-1)}</em> : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1,-1)}</code> : part)}</p>; };
  return value.split(/\n+/).map((line, index) => line.startsWith('## ') ? <h3 key={index}>{line.slice(3)}</h3> : line.startsWith('- ') ? <div className="preview-list-item" key={index}>• {line.slice(2)}</div> : inline(line, index));
}
