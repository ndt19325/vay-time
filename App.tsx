import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';

import { GameMode, Player } from './types';
import type { GameState } from './types';
import { createEmptyBoard, processMove, findRandomMove, serializeBoard, calculateScores } from './gameLogic';
import { Board } from './components/Board';

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [passCount, setPassCount] = useState(0);
  const [serializedHistory, setSerializedHistory] = useState<string[]>([]);
  
  const [peerId, setPeerId] = useState<string>('');
  const [remotePeerId, setRemotePeerId] = useState<string>('');
  const [myRole, setMyRole] = useState<Player | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);

  // --- LOGIC ĐỒNG BỘ NƯỚC ĐI ---
  const handleMove = useCallback((r: number, c: number, isRemote: boolean = false) => {
    setGameState(prev => {
      if (!prev || prev.gameOver) return prev;
      
      // Chặn nếu không phải lượt của mình (khi đánh Online)
      if (prev.mode === GameMode.ONLINE && !isRemote && prev.currentPlayer !== myRole) {
        console.warn("Chưa tới lượt của bạn!");
        return prev;
      }

      const result = processMove(prev.board, r, c, prev.currentPlayer, serializedHistory);
      if (!result) return prev;

      // Gửi dữ liệu đi nếu mình là người thực hiện
      if (prev.mode === GameMode.ONLINE && !isRemote && connRef.current) {
        connRef.current.send({ type: 'MOVE', r, c });
      }

      setSerializedHistory(h => [...h, serializeBoard(result.newBoard)]);
      setPassCount(0);
      
      const updatedCaptures = { ...prev.captures };
      updatedCaptures[prev.currentPlayer] += result.capturedCount;

      return { 
        ...prev, 
        board: result.newBoard, 
        currentPlayer: prev.currentPlayer === Player.BLACK ? Player.WHITE : Player.BLACK, 
        captures: updatedCaptures 
      };
    });
  }, [serializedHistory, myRole]);

  const handleSurrender = useCallback((isRemote: boolean = false) => {
    setGameState(prev => {
      if (!prev) return prev;
      if (prev.mode === GameMode.ONLINE && !isRemote && connRef.current) {
        connRef.current.send({ type: 'SURRENDER' });
      }
      const winner = isRemote ? myRole : (myRole === Player.BLACK ? Player.WHITE : Player.BLACK);
      return { ...prev, gameOver: true, winner };
    });
    if (!isRemote) alert("Bạn đã đầu hàng!");
    else alert("Đối thủ đã đầu hàng! Bạn thắng cuộc.");
  }, [myRole]);

  const handlePass = useCallback(() => {
    setGameState(prev => {
      if (!prev || prev.gameOver || prev.mode === GameMode.ONLINE) return prev;
      if (passCount + 1 >= 2) {
        const scores = calculateScores(prev.board);
        return { ...prev, gameOver: true, winner: scores.black > scores.white ? Player.BLACK : Player.WHITE };
      }
      setPassCount(pc => pc + 1);
      return { ...prev, currentPlayer: prev.currentPlayer === Player.BLACK ? Player.WHITE : Player.BLACK };
    });
  }, [passCount]);

  // --- THIẾT LẬP KẾT NỐI (QUAN TRỌNG CHO MOBILE) ---
  const setupConnection = (conn: DataConnection) => {
    connRef.current = conn;
    
    conn.on('open', () => {
      console.log("Kết nối P2P đã mở!");
      setIsConnecting(false);
    });

    conn.on('data', (data: any) => {
      console.log("Nhận dữ liệu:", data);
      if (data.type === 'MOVE') {
        handleMove(data.r, data.c, true);
      } else if (data.type === 'SURRENDER') {
        handleSurrender(true);
      } else if (data.type === 'START_GAME') {
        // Đồng bộ khởi tạo game cho bên nhận kết nối
        startNewGame(GameMode.ONLINE, false);
      }
    });

    conn.on('close', () => {
      alert("Kết nối bị ngắt!");
      window.location.reload();
    });

    conn.on('error', (err) => {
      console.error("Lỗi kết nối:", err);
      setIsConnecting(false);
    });
  };

  const initPeer = () => {
    // Cấu hình STUN server để có thể kết nối khác mạng (4G -> Wifi)
    const peer = new Peer({
      config: {
        'iceServers': [
          { url: 'stun:stun.l.google.com:19302' },
          { url: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    peer.on('open', (id) => setPeerId(id));
    
    peer.on('connection', (conn) => {
      setMyRole(Player.BLACK); // Người tạo phòng là quân Đen
      setupConnection(conn);
      // Thông báo cho bên kia bắt đầu
      setTimeout(() => {
        conn.send({ type: 'START_GAME' });
        startNewGame(GameMode.ONLINE, false);
      }, 500);
    });

    peerRef.current = peer;
  };

  const connectToPeer = () => {
    if (!remotePeerId || !peerRef.current) return;
    setIsConnecting(true);
    const conn = peerRef.current.connect(remotePeerId);
    setMyRole(Player.WHITE); // Người kết nối là quân Trắng
    setupConnection(conn);
  };

  const startNewGame = (mode: GameMode, shouldResetRole = true) => {
    const empty = createEmptyBoard();
    setGameState({
      board: empty,
      currentPlayer: Player.BLACK,
      mode,
      captures: { [Player.BLACK]: 0, [Player.WHITE]: 0, [Player.NONE]: 0 },
      gameOver: false,
      history: [empty],
      winner: null
    });
    setSerializedHistory([serializeBoard(empty)]);
    setPassCount(0);
    if (shouldResetRole) setMyRole(null);
  };

  const handleExit = () => {
    if (connRef.current) connRef.current.close();
    window.location.reload();
  };

  // AI Logic
  useEffect(() => {
    if (gameState?.mode === GameMode.SINGLE && gameState.currentPlayer === Player.WHITE && !gameState.gameOver) {
      const timer = setTimeout(() => {
        const move = findRandomMove(gameState.board, serializedHistory, gameState.captures[Player.BLACK]);
        if (move) handleMove(move[0], move[1]);
        else handlePass();
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [gameState, handleMove, handlePass, serializedHistory]);

  const finalScores = useMemo(() => {
    if (gameState?.gameOver) return calculateScores(gameState.board);
    return null;
  }, [gameState]);

  // --- GIAO DIỆN ---
  if (!gameState && !peerId) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[#0a0a0c] text-white">
        <h1 className="text-5xl md:text-8xl font-black font-serif-jp text-transparent bg-clip-text bg-gradient-to-b from-white to-amber-200/50 mb-12 uppercase">Vây Time</h1>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-4xl">
          <button onClick={() => startNewGame(GameMode.SINGLE)} className="bg-white/5 p-6 rounded-2xl border border-white/10 hover:bg-white/10 font-bold uppercase tracking-widest">Đánh Đơn</button>
          <button onClick={() => startNewGame(GameMode.DOUBLE)} className="bg-white/5 p-6 rounded-2xl border border-white/10 hover:bg-white/10 font-bold uppercase tracking-widest">Đánh Đôi</button>
          <button onClick={initPeer} className="bg-amber-500/10 p-6 rounded-2xl border border-amber-500/20 hover:bg-amber-500/20 font-bold uppercase tracking-widest text-amber-500">Trực Tuyến</button>
        </div>
      </div>
    );
  }

  if (!gameState && peerId) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[#0a0a0c] text-white">
        <div className="bg-white/5 p-8 rounded-3xl border border-white/10 w-full max-w-md text-center">
          <h2 className="text-xl font-bold mb-6 uppercase tracking-widest text-amber-500">Sảnh Trực Tuyến</h2>
          <p className="text-[10px] text-slate-500 mb-2 uppercase">ID của bạn (Gửi cho bạn bè):</p>
          <div className="bg-black p-4 rounded-xl border border-white/10 font-mono text-amber-500 break-all text-sm mb-8 select-all">
            {peerId}
          </div>
          <div className="space-y-4">
            <input 
              className="w-full bg-black border border-white/10 p-4 rounded-xl outline-none focus:border-amber-500 text-white text-center" 
              placeholder="Dán ID của đối thủ vào đây..." 
              value={remotePeerId} 
              onChange={e => setRemotePeerId(e.target.value)} 
            />
            <button 
              onClick={connectToPeer} 
              disabled={isConnecting}
              className={`w-full py-4 rounded-xl font-bold uppercase tracking-widest transition-all ${isConnecting ? 'bg-slate-700' : 'bg-amber-500 text-black'}`}
            >
              {isConnecting ? 'Đang kết nối...' : 'Kết Nối & Vào Trận'}
            </button>
          </div>
          <button onClick={() => window.location.reload()} className="mt-8 text-slate-500 text-xs uppercase tracking-tighter">Hủy và quay lại</button>
        </div>
      </div>
    );
  }

  if (!gameState) return null;

  return (
    <div className="min-h-[100dvh] bg-[#0c111d] text-slate-100 flex flex-col items-center p-2 md:p-8">
      {gameState.mode === GameMode.ONLINE && (
        <div className="mb-4 px-4 py-1 bg-amber-500/20 border border-amber-500/30 rounded-full text-[10px] uppercase tracking-widest text-amber-500 font-bold animate-pulse">
           {gameState.currentPlayer === myRole ? "ĐẾN LƯỢT BẠN" : "ĐỐI THỦ ĐANG ĐI..."} 
           ({myRole === Player.BLACK ? 'QUÂN ĐEN' : 'QUÂN TRẮNG'})
        </div>
      )}

      <div className="w-full max-w-2xl flex justify-between items-center mb-4 bg-slate-800/30 p-4 rounded-2xl border border-white/5">
        <div className={`p-2 px-4 rounded-xl transition-all ${gameState.currentPlayer === Player.BLACK ? 'bg-black ring-2 ring-amber-500' : 'opacity-20'}`}>
          <div className="text-[8px] font-bold text-center">BLACK</div>
          <div className="text-2xl font-black text-center">{gameState.captures[Player.BLACK]}</div>
        </div>
        <div className={`p-2 px-4 rounded-xl transition-all ${gameState.currentPlayer === Player.WHITE ? 'bg-white text-black ring-2 ring-amber-500' : 'opacity-20'}`}>
          <div className="text-[8px] font-bold text-center">WHITE</div>
          <div className="text-2xl font-black text-center">{gameState.captures[Player.WHITE]}</div>
        </div>
      </div>

      <div className="w-full max-w-[min(95vw,550px)] aspect-square">
        <Board board={gameState.board} onCellClick={handleMove} nextPlayer={gameState.currentPlayer} />
      </div>

      <div className="w-full max-w-2xl mt-6 grid grid-cols-2 md:grid-cols-3 gap-2 px-2">
        {gameState.mode !== GameMode.ONLINE ? (
          <button onClick={handlePass} className="bg-slate-800/50 py-4 rounded-xl font-bold text-xs uppercase tracking-widest">Bỏ lượt</button>
        ) : (
          <button disabled className="bg-slate-800/10 py-4 rounded-xl font-bold text-xs uppercase tracking-widest opacity-20 cursor-not-allowed">Bỏ lượt (Khóa)</button>
        )}
        <button onClick={() => handleSurrender(false)} className="bg-red-950/20 text-red-400 py-4 rounded-xl font-bold text-xs uppercase tracking-widest">Đầu hàng</button>
        <button onClick={handleExit} className="bg-slate-800/50 py-4 rounded-xl font-bold text-xs uppercase tracking-widest col-span-2 md:col-span-1">Thoát</button>
      </div>

      {gameState.gameOver && (
        <div className="fixed inset-0 bg-black/95 backdrop-blur-md flex items-center justify-center z-50 p-4 text-center">
          <div className="w-full max-w-sm p-8 rounded-3xl border border-white/10 bg-white/5">
            <h2 className="text-5xl font-black font-serif-jp text-amber-500 mb-4 uppercase">Hạ Màn</h2>
            <p className="text-xl mb-8 font-bold tracking-[0.2em] uppercase">
              {gameState.winner === Player.BLACK ? 'Quân Đen Thắng' : 'Quân Trắng Thắng'}
            </p>
            {finalScores && (
              <div className="grid grid-cols-2 gap-4 mb-8">
                <div className="bg-black/40 p-4 rounded-2xl border border-white/5">
                  <div className="text-[10px] text-slate-500 uppercase mb-1">Đen</div>
                  <div className="text-3xl font-black">{finalScores.black}</div>
                </div>
                <div className="bg-white/10 p-4 rounded-2xl border border-white/5">
                  <div className="text-[10px] text-slate-500 uppercase mb-1">Trắng</div>
                  <div className="text-3xl font-black">{finalScores.white}</div>
                </div>
              </div>
            )}
            <button onClick={handleExit} className="w-full bg-amber-500 text-black py-4 rounded-full font-black uppercase tracking-widest shadow-lg shadow-amber-500/20">Về Menu</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;