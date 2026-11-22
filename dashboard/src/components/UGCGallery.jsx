import React, { useState, useEffect, useMemo } from 'react';
import { Film, Download, Copy, Check, Loader2, Play } from 'lucide-react';
import { getApiUrl } from '../config';
import Modal from './ui/Modal';

export default function UGCGallery({ userResults = null, jobId = null, sessionStatus = 'completed', onCreateClips = null }) {
  const [serverVideos, setServerVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(getApiUrl('/api/saasshorts/gallery?limit=100'))
      .then((r) => (r.ok ? r.json() : { videos: [] }))
      .then((d) => {
        if (active) setServerVideos(Array.isArray(d.videos) ? d.videos : []);
      })
      .catch(() => {
        if (active) setServerVideos([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [userResults]);

  const videos = useMemo(() => {
    const byUrl = new Map();
    for (const v of serverVideos) {
      if (v?.video_url) byUrl.set(v.video_url, v);
    }
    if (Array.isArray(userResults?.clips)) {
      userResults.clips.forEach((clip, idx) => {
        if (!clip?.video_url || byUrl.has(clip.video_url)) return;
        const start = Number(clip.start) || 0;
        const end = Number(clip.end) || start + 20;
        byUrl.set(clip.video_url, {
          video_id: `session_${idx}_${clip.video_url}`,
          job_id: jobId,
          title: clip.video_title_for_youtube_short || `Clip ${idx + 1}`,
          session_title: 'Current clip session',
          session_status: sessionStatus,
          video_url: clip.video_url,
          actor_url: null,
          duration: Math.max(1, Math.round(end - start)),
          predicted_score: clip.predicted_score ?? null,
          caption: clip.video_description_for_tiktok || clip.why || '',
          hashtags: [],
        });
      });
    }
    return Array.from(byUrl.values());
  }, [jobId, serverVideos, sessionStatus, userResults]);

  const sessions = useMemo(() => {
    const groups = new Map();
    for (const video of videos) {
      const id = video.job_id || 'other';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(video);
    }
    return Array.from(groups.entries());
  }, [videos]);

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(''), 2000);
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow mb-1">02 · UGC GALLERY</p>
        <h2 className="font-display lowercase text-2xl md:text-3xl text-ink">ugc gallery</h2>
        <p className="readout mt-2">
          {loading ? '…' : videos.length} {videos.length === 1 ? 'video' : 'videos'} created by you
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 size={24} className="animate-spin text-brass" />
          <span className="ml-2 text-muted lowercase">Loading your videos...</span>
        </div>
      ) : videos.length === 0 ? (
        <div className="card text-center py-16 px-6 space-y-4">
          <Film size={40} className="mx-auto text-muted opacity-40" />
          <p className="text-sm text-muted lowercase">
            No videos created yet. Generate clips in Clip Generator to see them here.
          </p>
          {onCreateClips && (
            <button
              type="button"
              onClick={onCreateClips}
              className="btn-primary px-5 py-2 text-xs lowercase inline-flex items-center gap-2"
            >
              create clips
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {sessions.map(([sessionId, sessionVideos]) => {
            const session = sessionVideos[0];
            const status = session.session_status || 'completed';
            return (
              <section key={sessionId} aria-label={`${session.session_title || 'Clip session'} gallery`}>
                <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-rule pb-2">
                  <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    {session.session_title || 'Clip session'}
                  </h3>
                  <span className={status === 'stopped' ? 'badge-warn' : status === 'processing' ? 'badge-brass' : 'badge-ok'}>
                    {status}
                  </span>
                  <span className="readout">{sessionVideos.length} clips</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {sessionVideos.map((video) => (
                    <VideoCard
                      key={video.video_id || video.video_url}
                      video={video}
                      copied={copied}
                      onCopy={handleCopy}
                      onOpen={() => setSelected(video)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {selected && (
        <Modal
          isOpen
          onClose={() => setSelected(null)}
          size="sm"
          eyebrow={selected.predicted_score != null ? `SCORE ${selected.predicted_score}/100` : 'YOUR CLIP'}
          title={selected.title || 'Untitled'}
          footer={
            <a
              href={selected.video_url}
              download
              className="btn-ghost w-full justify-center text-sm"
            >
              <Download size={14} /> Download
            </a>
          }
        >
          <video
            src={selected.video_url}
            poster={selected.actor_url || undefined}
            controls
            autoPlay
            playsInline
            className="w-full rounded-input bg-black aspect-[9/16] object-contain max-h-[48vh] mx-auto"
          />
          <p className="readout mt-3">
            {selected.duration != null ? `${Number(selected.duration).toFixed(0)}s` : ''}
          </p>
          {selected.caption && (
            <p className="text-sm text-muted mt-2 leading-relaxed">{selected.caption}</p>
          )}
        </Modal>
      )}
    </div>
  );
}

function VideoCard({ video, copied, onCopy, onOpen }) {
  const caption = video.caption || '';
  const hashtags = (video.hashtags || []).join(' ');

  return (
    <div className="group card overflow-hidden transition-colors hover:border-rule2">
      <button
        type="button"
        onClick={onOpen}
        className="relative aspect-[9/16] w-full p-0 border-0 bg-black overflow-hidden cursor-pointer block"
        aria-label={`Play ${video.title || 'video'}`}
      >
        {video.actor_url ? (
          <img
            src={video.actor_url}
            alt={video.title || ''}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
        ) : (
          <video
            src={`${video.video_url}#t=0.5`}
            muted
            playsInline
            preload="metadata"
            className="w-full h-full object-cover pointer-events-none"
          />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
          <Play size={20} className="text-white/90" />
        </div>
        {video.predicted_score != null && (
          <div className="absolute top-1.5 right-1.5">
            <span className="badge-brass bg-black/75 text-white">
              {video.predicted_score}/100
            </span>
          </div>
        )}
      </button>

      <div className="p-2.5 space-y-1.5">
        <h3 className="text-xs font-semibold text-ink truncate">{video.title || 'Untitled'}</h3>
        <p className="readout">
          {video.duration != null ? `${Number(video.duration).toFixed(0)}s` : 'clip'}
        </p>
        {caption && (
          <div className="relative pr-4">
            <p className="text-micro text-muted line-clamp-2">{caption}</p>
            <button
              type="button"
              onClick={() => onCopy(`${caption}${hashtags ? `\n${hashtags}` : ''}`, `caption-${video.video_id}`)}
              className="absolute top-0 right-0 p-0.5 text-muted hover:text-brass transition-colors"
              title="Copy caption"
              aria-label="Copy caption"
            >
              {copied === `caption-${video.video_id}` ? <Check size={10} className="text-ok" /> : <Copy size={10} />}
            </button>
          </div>
        )}
        <a
          href={video.video_url}
          download
          className="block text-center text-micro lowercase bg-paper3 hover:brightness-110 text-muted hover:text-ink2 py-1 rounded-full transition-all"
        >
          <Download size={10} className="inline mr-0.5" />Download
        </a>
      </div>
    </div>
  );
}
