'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Eraser, History, Minimize2, PencilLine, RotateCcw } from 'lucide-react';
import { WhiteboardCanvas } from './whiteboard-canvas';
import type { WhiteboardCanvasHandle } from './whiteboard-canvas';
import { WhiteboardHistory } from './whiteboard-history';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createStageAPI } from '@/lib/api/stage-api';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { refreshWhiteboardRuntimeProjection } from '@/lib/whiteboard/runtime/browser-projection';

interface WhiteboardProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

/**
 * Whiteboard component
 */
export function Whiteboard({ isOpen, onClose }: WhiteboardProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const stage = useStageStore.use.stage();
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const clearingRef = useRef(false);
  const previousStageIdRef = useRef<string | undefined>(undefined);
  const wasOpenRef = useRef(isOpen);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewModified, setViewModified] = useState(false);
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);
  const snapshotCount = useWhiteboardHistoryStore((s) => s.snapshots.length);
  const runtimeProjection = useCanvasStore.use.runtimeWhiteboardProjection();

  // Get element count for indicator
  const runtimeAuthoritative =
    runtimeProjection !== null &&
    runtimeProjection.stageId === stage?.id &&
    runtimeProjection.lastSeq !== null;
  const whiteboard = runtimeAuthoritative ? runtimeProjection!.whiteboard : stage?.whiteboard?.[0];
  const elementCount = whiteboard?.elements?.length || 0;

  useEffect(() => {
    const stageId = stage?.id;
    const stageChanged = previousStageIdRef.current !== stageId;
    const opened = !wasOpenRef.current && isOpen;
    previousStageIdRef.current = stageId;
    wasOpenRef.current = isOpen;

    if (!stageId) {
      useCanvasStore.getState().clearRuntimeWhiteboardProjection();
      return;
    }
    if (stageChanged || opened) {
      void refreshWhiteboardRuntimeProjection(stageId);
    }
  }, [isOpen, stage?.id]);

  useEffect(() => {
    if (runtimeAuthoritative) setHistoryOpen(false);
  }, [runtimeAuthoritative]);

  const stageAPI = createStageAPI(useStageStore);

  const handleClear = async () => {
    if (!whiteboard || elementCount === 0 || clearingRef.current) return;
    clearingRef.current = true;

    // Save snapshot before clearing
    if (whiteboard.elements && whiteboard.elements.length > 0) {
      useWhiteboardHistoryStore.getState().pushSnapshot(whiteboard.elements);
    }

    // Trigger cascade exit animation
    useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade: base 380ms + 55ms per element, capped at 1400ms
    const animMs = Math.min(380 + elementCount * 55, 1400);
    await new Promise((resolve) => setTimeout(resolve, animMs));

    // Actually remove elements
    const result = stageAPI.whiteboard.delete(whiteboard.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
    clearingRef.current = false;

    if (result.success) {
      toast.success(t('whiteboard.clearSuccess'));
    } else {
      toast.error(t('whiteboard.clearError') + result.error);
    }
  };

  return (
    <>
      {/* Main Whiteboard Overlay */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.92, y: reduceMotion ? 0 : 30 }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
              transition: {
                type: reduceMotion ? 'tween' : 'spring',
                duration: reduceMotion ? 0 : undefined,
                stiffness: 120,
                damping: 18,
                mass: 1.2,
              },
            }}
            exit={{
              opacity: 0,
              scale: reduceMotion ? 1 : 0.95,
              y: reduceMotion ? 0 : 16,
              transition: { duration: reduceMotion ? 0 : 0.5, ease: [0.4, 0, 0.2, 1] },
            }}
            className="absolute inset-4 pointer-events-auto bg-card/95 backdrop-blur-2xl rounded-3xl shadow-[0_32px_80px_-20px_rgba(0,0,0,0.25)] border-2 border-primary/25 flex flex-col overflow-hidden z-[120] ring-4 ring-primary/10"
          >
            {/* Header */}
            <div className="h-14 px-6 border-b border-border flex items-center justify-between shrink-0 bg-card/50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                  <PencilLine className="w-4 h-4" />
                </div>
                <span className="font-bold text-foreground tracking-tight">
                  {t('whiteboard.title')}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <AnimatePresence>
                  {viewModified && (
                    <motion.button
                      type="button"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.15 }}
                      onClick={() => canvasRef.current?.resetView()}
                      whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                      className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
                      title={t('whiteboard.resetView')}
                    >
                      <RotateCcw className="w-4 h-4" />
                    </motion.button>
                  )}
                </AnimatePresence>
                {!runtimeAuthoritative && (
                  <>
                    <motion.button
                      type="button"
                      onClick={handleClear}
                      disabled={isClearing || elementCount === 0}
                      whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                      className="p-2 text-muted-foreground hover:text-mistake hover:bg-mistake-soft rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none"
                      title={t('whiteboard.clear')}
                    >
                      <motion.div
                        animate={
                          isClearing && !reduceMotion
                            ? { rotate: [0, -15, 15, -10, 10, 0] }
                            : { rotate: 0 }
                        }
                        transition={
                          reduceMotion
                            ? { duration: 0 }
                            : isClearing
                              ? { duration: 0.5, ease: 'easeInOut' }
                              : { duration: 0.2 }
                        }
                      >
                        <Eraser className="w-4 h-4" />
                      </motion.div>
                    </motion.button>
                    <div className="relative">
                      <motion.button
                        type="button"
                        onClick={() => setHistoryOpen(!historyOpen)}
                        whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                        className="relative p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
                        title={t('whiteboard.history')}
                      >
                        <History className="w-4 h-4" />
                        {snapshotCount > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                            {snapshotCount}
                          </span>
                        )}
                      </motion.button>
                      <WhiteboardHistory
                        isOpen={historyOpen}
                        onClose={() => setHistoryOpen(false)}
                      />
                    </div>
                  </>
                )}
                <div className="w-px h-4 bg-muted mx-1" />
                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
                  title={t('whiteboard.minimize')}
                >
                  <Minimize2 className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Whiteboard Content Area */}
            <div className="flex-1 relative bg-[radial-gradient(var(--border-strong)_1px,transparent_1px)] [background-size:24px_24px] overflow-hidden">
              <WhiteboardCanvas
                ref={canvasRef}
                whiteboard={whiteboard}
                onViewModifiedChange={setViewModified}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
