import { useState } from 'react'
import { CloudCheck, CloudExclamationPoint, CloudOff, FileText, Folder as FolderIcon, FolderOpen, FolderPlus, HardDrive, Menu, CloudSync, Star, Trash2, X } from 'lucide-react'
import type { DB, View } from '../types'
import type { SyncStatus } from '../store'

const SYNC: Record<SyncStatus, { Icon: typeof CloudCheck; label: string }> = {
  local: { Icon: HardDrive, label: 'Saved on this device' },
  syncing: { Icon: CloudSync, label: 'Syncing…' },
  synced: { Icon: CloudCheck, label: 'Synced with home server' },
  offline: { Icon: CloudOff, label: 'Offline – changes kept on this device' },
  error: { Icon: CloudExclamationPoint, label: 'Sync error – changes kept on this device' },
}

interface Props {
  db: DB
  view: View
  sync: SyncStatus
  /** Notes still waiting to be uploaded. */
  left: number
  collapsed: boolean
  onToggle: () => void
  onView: (v: View) => void
  onCreateFolder: (name: string) => void
  onDeleteFolder: (id: string) => void
}

export default function Sidebar({ db, view, sync, left, collapsed, onToggle, onView, onCreateFolder, onDeleteFolder }: Props) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const live = db.notes.filter((n) => !n.trashed)
  const is = (v: View) => view.kind === v.kind && (v.kind !== 'folder' || (view.kind === 'folder' && view.id === v.id))

  const item = (v: View, icon: React.ReactNode, label: string, count?: number) => (
    <button className={`side-item ${is(v) ? 'on' : ''}`} onClick={() => onView(v)} title={label}>
      {icon}
      {!collapsed && <span className="side-label">{label}</span>}
      {!collapsed && count !== undefined && <span className="side-count">{count}</span>}
    </button>
  )

  const submit = () => {
    if (name.trim()) onCreateFolder(name.trim())
    setName('')
    setAdding(false)
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <button className="icon-btn hamburger" onClick={onToggle} title="Menu">
        <Menu size={20} />
      </button>
      {item({ kind: 'all' }, <FileText size={18} />, 'All notes', live.length)}
      {item({ kind: 'favorites' }, <Star size={18} />, 'Favorites', live.filter((n) => n.favorite).length)}
      {item({ kind: 'trash' }, <Trash2 size={18} />, 'Trash', db.notes.length - live.length)}

      <div className="side-divider" />
      <div className="folders-head">
        {item(
          { kind: 'folders' },
          <FolderOpen size={18} />,
          'Folders',
          db.folders.length + live.filter((n) => !n.folderId).length,
        )}
        {!collapsed && (
          <button className="icon-btn small folder-add" onClick={() => setAdding(true)} title="New folder">
            <FolderPlus size={16} />
          </button>
        )}
      </div>
      {!collapsed && adding && (
        <input
          autoFocus
          className="folder-input"
          placeholder="Folder name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => (e.key === 'Enter' ? submit() : e.key === 'Escape' && setAdding(false))}
          onBlur={submit}
        />
      )}
      {db.folders.map((f) => (
        <div key={f.id} className="folder-row">
          {item(
            { kind: 'folder', id: f.id },
            <FolderIcon size={18} />,
            f.name,
            live.filter((n) => n.folderId === f.id).length,
          )}
          {!collapsed && (
            <button
              className="icon-btn small folder-del"
              title="Delete folder (notes are kept)"
              onClick={() => confirm(`Delete folder "${f.name}"? Notes stay in All notes.`) && onDeleteFolder(f.id)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      <div className={`sync-status ${sync}`} title={SYNC[sync].label}>
        {(() => {
          const { Icon } = SYNC[sync]
          return <Icon size={14} />
        })()}
        {!collapsed && <span>{sync === 'syncing' && left > 1 ? `Uploading… ${left} notes left` : SYNC[sync].label}</span>}
      </div>
    </aside>
  )
}
