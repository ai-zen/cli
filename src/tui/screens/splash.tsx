// 由 src/tui/screens.tsx 拆分而来 —— 启动界面 Splash
import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { theme, pickLogo, logoGradientColors } from "../theme.js";
import { Spinner } from "../components.js";
import { CLI_VERSION, SDK_VERSION, CORE_VERSION } from "../../version.js";

// ==================== Splash（启动界面）====================

export const TAGLINE = "终端里的 AI 协作台";

export function Splash({ onDone }: { onDone?: () => void }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const logo = pickLogo(columns ?? 80);
  const [revealed, setRevealed] = useState(0);
  const [phase, setPhase] = useState(0);
  const [ready, setReady] = useState(false);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone?.();
    exit("done");
  };

  useEffect(() => {
    const revealTimer = setInterval(
      () => setRevealed((r) => Math.min(r + 1, logo.length)),
      55,
    );
    const sweepTimer = setInterval(() => setPhase((p) => Math.min(p + 0.05, 1)), 35);
    return () => {
      clearInterval(revealTimer);
      clearInterval(sweepTimer);
    };
  }, [logo.length]);

  useEffect(() => {
    if (revealed >= logo.length && phase >= 1) setReady(true);
  }, [revealed, phase, logo.length]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(finish, 1100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useInput(() => finish());

  const totalRows = rows ?? 24;
  const padTop = Math.max(0, Math.floor((totalRows - (logo.length + 9)) / 2));
  const visibleLogo = logo.slice(0, revealed);
  const logoColors = logoGradientColors(visibleLogo, phase);

  return (
    <Box flexDirection="column" alignItems="center" paddingTop={padTop} width={columns}>
      <Box flexDirection="column" alignItems="center">
        {visibleLogo.map((line, i) => (
          <Text key={i}>
            {[...line].map((ch, x) => (
              <Text key={x} color={logoColors[i]?.[x]}>
                {ch}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.accent}>{TAGLINE}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          v{CLI_VERSION} · sdk {SDK_VERSION} · core {CORE_VERSION}
        </Text>
      </Box>
      <Box marginTop={2} flexDirection="column" alignItems="center">
        {ready ? (
          <Text color={theme.faint}>按任意键开始…</Text>
        ) : (
          <Spinner label="正在准备" />
        )}
      </Box>
    </Box>
  );
}

