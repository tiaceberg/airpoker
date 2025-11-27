import {
  collection,
  addDoc,
  serverTimestamp,
  doc,
  setDoc,
  getDoc,
  getDocs,
  query,
  orderBy,
  updateDoc,
  writeBatch,
  where
} from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "./firebase";


export interface CreateTableInput {
  name: string;
  password?: string;
  initialStack: number;
  smallBlind: number;
  bigBlind: number;
}

export interface HandData {
  handNumber: number;
  stage: "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN";
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  currentTurnIndex: number;
  pot: number;
  currentBet: number;
  roundBets: Record<string, number>;
  firstToActIndex: number;
  votingOpen?: boolean;
  votes?: Record<string, string>;
  winnerId?: string | null;
}


/**
 * Crea un nuovo tavolo e aggiunge l'utente come primo giocatore (seatIndex 0).
 */
function generateShortTableId() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 5; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// genera un ID univoco controllando che il doc non esista
async function generateUniqueTableId(): Promise<string> {
  const tablesCol = collection(db, "tables");

  while (true) {
    const candidate = generateShortTableId();
    const candidateRef = doc(tablesCol, candidate);
    const snap = await getDoc(candidateRef);
    if (!snap.exists()) {
      return candidate;
    }
    // se esiste già, riprova
  }
}

export async function createTable(data: CreateTableInput, user: User | null) {
  if (!user) {
    throw new Error("User non presente durante la creazione del tavolo");
  }

  const uid = user.uid;

  const tablesCol = collection(db, "tables");

  const tableId = await generateUniqueTableId();
  const tableRef = doc(tablesCol, tableId);

  await setDoc(tableRef, {
    name: data.name,
    initialStack: data.initialStack,
    smallBlind: data.smallBlind,
    bigBlind: data.bigBlind,
    hostId: uid,
    state: "LOBBY",
    password: data.password || null,
    createdAt: serverTimestamp(),
    endedAt: null,
    currentHandId: null,
  });

  // Aggiunge subito l'host come giocatore seduto al tavolo (seatIndex 0)
  const playerRef = doc(db, "tables", tableId, "players", uid);
  await setDoc(playerRef, {
    userId: uid,
    displayName: user.displayName,
    stack: data.initialStack,
    seatIndex: 0,
    isReady: false,
    isFolded: false,
    isSittingOut: false,
    joinedAt: serverTimestamp(),
  });

  return tableId;
}

/**
 * Entra in un tavolo esistente aggiungendo il giocatore se non è già seduto.
 */
export async function joinTable(tableId: string, user: User | null, password?: string) {
  if (!user) throw new Error("User non presente durante il join del tavolo");

  const tableRef = doc(db, "tables", tableId);
  const snap = await getDoc(tableRef);

  if (!snap.exists()) {
    throw new Error("Il tavolo non esiste");
  }

  const data = snap.data() as any;

  if (data.password) {
    if (!password || password !== data.password) {
      throw new Error("Password del tavolo non corretta.");
    }
  }
  const initialStack = data.initialStack;

  const playerRef = doc(db, "tables", tableId, "players", user.uid);
  const playerSnap = await getDoc(playerRef);

  if (playerSnap.exists()) {
    // Già seduto, niente da fare
    return;
  }

  // Calcola prossimo seatIndex
  const playersRef = collection(db, "tables", tableId, "players");
  const q = query(playersRef, orderBy("seatIndex", "asc"));
  const playersSnap = await getDocs(q);
  const seatIndex = playersSnap.size;

  await setDoc(playerRef, {
    userId: user.uid,
    displayName: user.displayName,
    stack: initialStack,
    seatIndex,
    isReady: false,
    isFolded: false,
    joinedAt: serverTimestamp()
  });
}

/**
 * Imposta lo stato "pronto / non pronto" per il player corrente.
 */
export async function setPlayerReady(
  tableId: string,
  user: User | null,
  isReady: boolean
) {
  if (!user) throw new Error("User non presente per setPlayerReady");

  const playerRef = doc(db, "tables", tableId, "players", user.uid);
  await updateDoc(playerRef, { isReady });
}

export async function leaveTable(tableId: string, user: User) {
  const playersRef = collection(db, "tables", tableId, "players");
  const q = query(playersRef, where("userId", "==", user.uid));
  const snap = await getDocs(q);

  const batch = writeBatch(db);
  snap.forEach((docSnap) => {
    batch.delete(docSnap.ref);
  });

  await batch.commit();
}

/**
 * Avvia la partita:
 * - controlla che ci siano almeno 2 giocatori
 * - crea la PRIMA mano (hand_1) con dealer, SB, BB, currentTurn
 * - setta lo stato del tavolo a IN_GAME + currentHandId
 * - resetta isReady per tutti
 */
export async function startGame(tableId: string) {
  const tableRef = doc(db, "tables", tableId);
  const tableSnap = await getDoc(tableRef);

  if (!tableSnap.exists()) {
    throw new Error("Tavolo inesistente");
  }

  const tableData = tableSnap.data() as any;

  if (tableData.state !== "LOBBY") {
    throw new Error("La partita è già iniziata o il tavolo non è in LOBBY");
  }

  const playersRef = collection(db, "tables", tableId, "players");
  const playersQuery = query(playersRef, orderBy("seatIndex", "asc"));
  const playersSnap = await getDocs(playersQuery);

  const players = playersSnap.docs.map((d) => {
    const data = d.data() as any;
    return {
      id: d.id,
      ref: d.ref,
      ...data
    };
  });

  if (players.length < 2) {
    throw new Error("Servono almeno 2 giocatori per iniziare");
  }

  const numPlayers = players.length;

  // Per ora: dealer = seatIndex 0 (primo in lista)
  const dealerIndex = 0;
  const smallBlindIndex = (dealerIndex + 1) % numPlayers;
  const bigBlindIndex = (dealerIndex + 2) % numPlayers;
  const currentTurnIndex = (bigBlindIndex + 1) % numPlayers; // UTG

  // Calcolo delle blind e dello stato iniziale del pot
  const sbAmount = Number(tableData.smallBlind) || 0;
  const bbAmount = Number(tableData.bigBlind) || 0;

  const firstToActIndex = (bigBlindIndex + 1) % players.length;

  let pot = 0;
  let currentBet = 0;
  const roundBets: Record<string, number> = {};

  // Se ci sono almeno 2 giocatori, applichiamo SB e BB
  if (numPlayers >= 2) {
    const sbPlayer = players[smallBlindIndex];
    const bbPlayer = players[bigBlindIndex];

    if (sbAmount > 0) {
      roundBets[sbPlayer.id] = sbAmount;
      pot += sbAmount;
    }

    if (bbAmount > 0) {
      roundBets[bbPlayer.id] = (roundBets[bbPlayer.id] || 0) + bbAmount;
      pot += bbAmount;
      currentBet = bbAmount;
    }
  }

const handData: HandData = {
  handNumber: 1,
  stage: "PREFLOP",
  dealerIndex,
  smallBlindIndex,
  bigBlindIndex,
  currentTurnIndex,
  pot,
  currentBet,
  roundBets,
  firstToActIndex
};


  // Crea una nuova hand nella subcollection "hands"
  const handsRef = collection(db, "tables", tableId, "hands");
  const handRef = await addDoc(handsRef, {
    ...handData,
    createdAt: serverTimestamp()
  });

  // Aggiorna il tavolo: IN_GAME + currentHandId
  await updateDoc(tableRef, {
    state: "IN_GAME",
    currentHandId: handRef.id
  });

  // Reset isReady di tutti i giocatori e scala le blind dagli stack
  const batch = writeBatch(db);
  players.forEach((p, index) => {
    let newStack = Number(p.stack) || 0;

    if (index === smallBlindIndex && sbAmount > 0) {
      newStack = Math.max(0, newStack - sbAmount);
    }
    if (index === bigBlindIndex && bbAmount > 0) {
      newStack = Math.max(0, newStack - bbAmount);
    }

    batch.update(p.ref, {
      isReady: false,
      stack: newStack,
      isFolded: false
    });
  });

  await batch.commit();
}


/**
 * Scambia i seatIndex di due giocatori (usato dall'host per riordinare).
 */
export async function swapSeats(
  tableId: string,
  playerAId: string,
  playerBId: string,
  seatA: number,
  seatB: number
) {
  const playerARef = doc(db, "tables", tableId, "players", playerAId);
  const playerBRef = doc(db, "tables", tableId, "players", playerBId);

  const batch = writeBatch(db);
  batch.update(playerARef, { seatIndex: seatB });
  batch.update(playerBRef, { seatIndex: seatA });

  await batch.commit();
}

export async function setSittingOut(
  tableId: string,
  user: User,
  isSittingOut: boolean
) {
  const playersRef = collection(db, "tables", tableId, "players");
  const q = query(playersRef, where("userId", "==", user.uid));
  const snap = await getDocs(q);

  const batch = writeBatch(db);
  snap.forEach((docSnap) => {
    batch.update(docSnap.ref, { isSittingOut });
  });

  await batch.commit();
}

export async function endGame(tableId: string) {
  const tableRef = doc(db, "tables", tableId);
  await updateDoc(tableRef, {
    state: "SUMMARY",
    endedAt: serverTimestamp()
  });
}

// Avvia una nuova mano dopo che la precedente è terminata (showdown completato)
export async function startNextHand(tableId: string, user: User) {
  const tableRef = doc(db, "tables", tableId);
  const tableSnap = await getDoc(tableRef);
  if (!tableSnap.exists()) throw new Error("Tavolo inesistente.");
  const tableData = tableSnap.data() as any;

  if (tableData.hostId !== user.uid) {
    throw new Error("Solo l'host può avviare la mano successiva.");
  }

  if (tableData.state !== "IN_GAME") {
    throw new Error("Il tavolo non è in stato di gioco.");
  }

  const prevHandId: string | null = tableData.currentHandId ?? null;
  if (!prevHandId) throw new Error("Nessuna mano precedente trovata.");

  const prevHandRef = doc(db, "tables", tableId, "hands", prevHandId);
  const prevHandSnap = await getDoc(prevHandRef);
  if (!prevHandSnap.exists()) throw new Error("Mano precedente non trovata.");

  const prevHand = prevHandSnap.data() as any as HandData;
  if (prevHand.stage !== "SHOWDOWN") {
    throw new Error("La mano corrente non è ancora in SHOWDOWN.");
  }

  // Prendiamo i giocatori ordinati per seatIndex
  const playersRef = collection(db, "tables", tableId, "players");
  const playersQuery = query(playersRef, orderBy("seatIndex", "asc"));
  const playersSnap = await getDocs(playersQuery);
  const players = playersSnap.docs.map((d) => {
    const data = d.data() as any;
    return {
      id: d.id,
      ref: d.ref,
      stack: Number(data.stack) || 0,
      seatIndex: data.seatIndex,
      isFolded: !!data.isFolded,
      isSittingOut: !!data.isSittingOut
    };
  });

  if (players.length < 2) {
    throw new Error("Servono almeno 2 giocatori per una nuova mano.");
  }

  const numPlayers = players.length;

  // Ruotiamo dealer, SB e BB di uno rispetto alla mano precedente
  const dealerIndex = (prevHand.dealerIndex + 1) % numPlayers;
  const smallBlindIndex = (dealerIndex + 1) % numPlayers;
  const bigBlindIndex = (dealerIndex + 2) % numPlayers;
  const currentTurnIndex = (bigBlindIndex + 1) % numPlayers; // UTG

  const sbAmount = Number(tableData.smallBlind) || 0;
  const bbAmount = Number(tableData.bigBlind) || 0;

  const firstToActIndex = currentTurnIndex;

  let pot = 0;
  let currentBet = 0;
  const roundBets: Record<string, number> = {};

  if (numPlayers >= 2) {
    const sbPlayer = players[smallBlindIndex];
    const bbPlayer = players[bigBlindIndex];

    if (sbAmount > 0) {
      roundBets[sbPlayer.id] = sbAmount;
      pot += sbAmount;
    }

    if (bbAmount > 0) {
      roundBets[bbPlayer.id] = (roundBets[bbPlayer.id] || 0) + bbAmount;
      pot += bbAmount;
      currentBet = bbAmount;
    }
  }

  const handsRef = collection(db, "tables", tableId, "hands");

  const newHand: HandData = {
    handNumber: (prevHand.handNumber || 1) + 1,
    stage: "PREFLOP",
    dealerIndex,
    smallBlindIndex,
    bigBlindIndex,
    currentTurnIndex,
    pot,
    currentBet,
    roundBets,
    firstToActIndex
  };

  const newHandRef = await addDoc(handsRef, {
    ...newHand,
    createdAt: serverTimestamp()
  });

  const batch = writeBatch(db);

  // Aggiorniamo il tavolo con la nuova mano corrente
  batch.update(tableRef, {
    currentHandId: newHandRef.id
  });

  // Reset stato giocatori per la nuova mano (isFolded false)
  players.forEach((p, index) => {
    let newStack = p.stack;

    if (index === smallBlindIndex && sbAmount > 0) {
      newStack = Math.max(0, newStack - sbAmount);
    }
    if (index === bigBlindIndex && bbAmount > 0) {
      newStack = Math.max(0, newStack - bbAmount);
    }

    batch.update(p.ref, {
      isFolded: false,
      stack: newStack
    });
  });

  await batch.commit();
}


export type PlayerActionType = "CHECK" | "CALL" | "BET" | "FOLD";

/**
 * Esegue una azione di gioco per il player corrente.
 * MVP: niente all-in, niente side pot.
 */
export async function playerAction(
  tableId: string,
  user: User | null,
  action: PlayerActionType,
  amount?: number
) {
  if (!user) throw new Error("User non presente per playerAction");

  const tableRef = doc(db, "tables", tableId);
  const tableSnap = await getDoc(tableRef);

  if (!tableSnap.exists()) {
    throw new Error("Tavolo inesistente");
  }

  const tableData = tableSnap.data() as any;

  if (tableData.state !== "IN_GAME") {
    throw new Error("La partita non è in stato IN_GAME");
  }

  const currentHandId: string | null = tableData.currentHandId ?? null;
  if (!currentHandId) {
    throw new Error("Nessuna mano corrente impostata");
  }

  const handRef = doc(db, "tables", tableId, "hands", currentHandId);
  const handSnap = await getDoc(handRef);

  if (!handSnap.exists()) {
    throw new Error("La mano corrente non esiste");
  }

  const handData = handSnap.data() as any as HandData;

  // Indice dell'ultimo giocatore che ha effettuato una bet/raise (aggressore)
  // Se non presente nel documento, di default usiamo firstToActIndex
  let lastAggressorIndex: number =
    (handData as any).lastAggressorIndex ?? handData.firstToActIndex;

  if (handData.currentTurnIndex == null || handData.currentTurnIndex < 0) {
    throw new Error("Non è il turno di nessuno al momento");
  }

  // Prendiamo i giocatori in ordine di seatIndex
  const playersRef = collection(db, "tables", tableId, "players");
  const q = query(playersRef, orderBy("seatIndex", "asc"));
  const playersSnap = await getDocs(q);

  const players = playersSnap.docs.map((d) => {
  const data = d.data() as any;
  return {
    id: d.id,
    ref: d.ref,
    userId: data.userId,
    displayName: data.displayName,
    stack: Number(data.stack) || 0,
    seatIndex: data.seatIndex,
    isFolded: !!data.isFolded,
    isSittingOut: !!data.isSittingOut      // 👈
  };
});


  if (players.length === 0) {
    throw new Error("Nessun giocatore al tavolo");
  }

  const numPlayers = players.length;
  const currentIndex = handData.currentTurnIndex;
  if (currentIndex < 0 || currentIndex >= numPlayers) {
    throw new Error("Indice turno non valido");
  }

  const currentPlayer = players[currentIndex];
  if (currentPlayer.userId !== user.uid) {
    throw new Error("Non è il tuo turno");
  }

  if (currentPlayer.isFolded) {
    throw new Error("Sei già foldato in questa mano");
  }

  // Round bets
  const roundBets: Record<string, number> = {
    ...(handData.roundBets || {})
  };

  const myBet = roundBets[user.uid] || 0;
  let pot = handData.pot;
  let currentBet = handData.currentBet;

  // Helper per trovare il prossimo giocatore attivo
function getNextActiveIndex(fromIndex: number): number {
  for (let i = 1; i <= numPlayers; i++) {
    const idx = (fromIndex + i) % numPlayers;
    const p = players[idx];
    if (!p.isFolded && !p.isSittingOut && p.stack > 0) {
      return idx;
    }
  }
  return -1;
}

let nextTurnIndexCandidate = getNextActiveIndex(currentIndex);
let nextTurnIndex = nextTurnIndexCandidate;
  // Eseguiamo l'azione
  switch (action) {
    case "CHECK": {
      if (myBet !== currentBet) {
        throw new Error("Non puoi fare check: devi ancora coprire la puntata.");
      }
      break;
    }

    case "CALL": {
      if (currentBet <= myBet) {
        throw new Error("Niente da chiamare.");
      }

      const diff = currentBet - myBet;
      if (currentPlayer.stack < diff) {
        throw new Error(
          "Stack insufficiente per il call (all-in non ancora gestito)."
        );
      }

      roundBets[user.uid] = myBet + diff;
      pot += diff;

      currentPlayer.stack -= diff;
      break;
    }

    case "BET": {
      const target = Number(amount);
      if (!target || target <= 0) {
        throw new Error("Importo bet/raise non valido.");
      }

      // target è la puntata TOTALE che vuoi avere nel round
      const maxFinal = myBet + currentPlayer.stack;
      if (target > maxFinal) {
        throw new Error(
          "Non puoi puntare più del tuo stack (all-in non ancora gestito)."
        );
      }

      if (currentBet === 0) {
        // Prima puntata del round: dev'essere > 0
        if (target <= 0) {
          throw new Error("La puntata deve essere maggiore di zero.");
        }
      } else {
        // Raise: nuova puntata totale deve essere > currentBet
        if (target <= currentBet) {
          throw new Error(
            "Il raise deve essere maggiore della puntata corrente."
          );
        }
      }

      const diff = target - myBet; // quanto aggiungi rispetto a quanto avevi già messo

      if (diff <= 0) {
        throw new Error("La nuova puntata deve aumentare il totale che hai investito.");
      }

      // Aggiorniamo roundBets, pot, currentBet, stack
      roundBets[user.uid] = target;
      pot += diff;
      currentBet = target;
      currentPlayer.stack -= diff;

      // L'ultimo aggressore diventa chi effettua questa bet/raise
      lastAggressorIndex = currentIndex;
      break;
    }


    case "FOLD": {
      currentPlayer.isFolded = true;
      break;
    }

    default:
      throw new Error("Azione non supportata");
  }

const activePlayers = players.filter(
  (p) => !p.isFolded && !p.isSittingOut
);

let newStage = handData.stage;

if (activePlayers.length <= 1) {
  newStage = "SHOWDOWN";
  nextTurnIndex = -1;
} else {
  const allMatched = activePlayers.every((p) => {
    const b = roundBets[p.userId] || 0;
    return b === currentBet;
  });

  if (handData.stage === "PREFLOP") {
    // PRE-FLOP: il giro deve concludersi dopo il turno del BB
    // (o dopo chiunque lo segua, in caso di raise), cioè dopo
    // che il giro è tornato al firstToAct originario e tutti
    // hanno eguagliato la puntata.
    const firstToAct = handData.firstToActIndex; // UTG preflop
    if (
      allMatched &&
      nextTurnIndexCandidate === firstToAct &&
      currentIndex !== firstToAct
    ) {
      // nessuno da far parlare: chiudiamo il giro preflop
      nextTurnIndex = -1;
    }
  } else {
    // POST-FLOP (FLOP, TURN, RIVER)
    // Da qui l'ordine DEVE essere: SB -> BB -> tutti gli altri.
    // L'ordine è già garantito da seatIndex e currentTurnIndex;
    // qui gestiamo solo la chiusura del giro quando tutti hanno
    // matched e l'azione ha completato il suo ciclo.

    if (currentBet === 0) {
      // Solo check: chiudiamo il round quando, partendo da firstToAct,
      // tutti hanno avuto la possibilità di agire e l'azione tornerebbe
      // nuovamente a firstToAct.
      const firstToAct = handData.firstToActIndex;
      if (
        allMatched &&
        nextTurnIndexCandidate === firstToAct &&
        currentIndex !== firstToAct
      ) {
        nextTurnIndex = -1;
      }
    } else {
      // C'è stata aggressione: teniamo traccia dell'ultimo aggressore
      // e chiudiamo il giro quando l'azione torna al giocatore
      // immediatamente precedente a lui e tutti hanno matched.

      function getPreviousActiveIndex(fromIndex: number): number {
        for (let i = 1; i <= numPlayers; i++) {
          const idx = (fromIndex - i + numPlayers) % numPlayers;
          const p = players[idx];
          if (!p.isFolded && !p.isSittingOut && p.stack > 0) {
            return idx;
          }
        }
        return -1;
      }

      const closerIndex = getPreviousActiveIndex(lastAggressorIndex);

      if (
        allMatched &&
        closerIndex !== -1 &&
        nextTurnIndexCandidate === closerIndex
      ) {
        nextTurnIndex = -1;
      }
    }
  }
}


  // Applichiamo gli update
  const batch = writeBatch(db);

  // Aggiorna i player (stack + isFolded)
    players.forEach((p) => {
    const ref = p.ref;
    const isFolded = p.isFolded;
    const newStack = p.stack;
    batch.update(ref, {
        isFolded,
        stack: newStack
    });
    });


  // Aggiorna la hand
  batch.update(handRef, {
    pot,
    currentBet,
    roundBets,
    currentTurnIndex: nextTurnIndex,
    stage: newStage,
    lastAggressorIndex
  });

  await batch.commit();
}


export async function advanceStage(tableId: string, user: User) {
  const tableRef = doc(db, "tables", tableId);
  const tableSnap = await getDoc(tableRef);
  if (!tableSnap.exists()) throw new Error("Tavolo inesistente.");
  const tableData = tableSnap.data() as any;

  if (tableData.hostId !== user.uid) {
    throw new Error("Solo l'host può avanzare la mano.");
  }

  const currentHandId = tableData.currentHandId;
  if (!currentHandId) throw new Error("Nessuna mano corrente.");

  const handRef = doc(db, "tables", tableId, "hands", currentHandId);
  const handSnap = await getDoc(handRef);
  if (!handSnap.exists()) throw new Error("Mano non trovata.");

  const hand = handSnap.data() as any as HandData;

  let nextStage: HandData["stage"] = hand.stage;
  if (hand.stage === "PREFLOP") nextStage = "FLOP";
  else if (hand.stage === "FLOP") nextStage = "TURN";
  else if (hand.stage === "TURN") nextStage = "RIVER";
  else if (hand.stage === "RIVER") nextStage = "SHOWDOWN";
  else throw new Error("La mano è già in SHOWDOWN.");

  // Calcoliamo nuovo firstToActIndex per FLOP/TURN/RIVER
  let firstToActIndex = hand.firstToActIndex;

  if (nextStage !== "SHOWDOWN") {
    const playersRef = collection(db, "tables", tableId, "players");
    const q = query(playersRef, orderBy("seatIndex", "asc"));
    const playersSnap = await getDocs(q);
    const players = playersSnap.docs.map((d) => {
      const data = d.data() as any;
      return {
        seatIndex: data.seatIndex,
        isFolded: !!data.isFolded,
        isSittingOut: !!data.isSittingOut
      };
    });

    const n = players.length;

    // AL FLOP deve partire SEMPRE lo SMALL BLIND.
    // Da TURN e RIVER parte il giocatore dopo il dealer.
    let startIndex: number;
    if (nextStage === "FLOP") {
      startIndex = hand.smallBlindIndex % n;
    } else {
      startIndex = (hand.dealerIndex + 1) % n;
    }

    let idx = startIndex;
    for (let i = 0; i < n; i++) {
      const p = players[idx];
      if (!p.isFolded && !p.isSittingOut) {
        firstToActIndex = idx;
        break;
      }
      idx = (idx + 1) % n;
    }
  }
  const updateData: any = {
    stage: nextStage,
    currentBet: 0,
    roundBets: {},
    currentTurnIndex: nextStage === "SHOWDOWN" ? -1 : firstToActIndex,
    firstToActIndex
  };

  // Se passiamo a SHOWDOWN dopo il river, apriamo la votazione
  if (hand.stage === "RIVER" && nextStage === "SHOWDOWN") {
    updateData.votingOpen = true;
    updateData.votes = {};
  }

  await updateDoc(handRef, updateData);
}


// Aggiunge o aggiorna il voto di un giocatore sul vincitore della mano
export async function voteWinner(
  tableId: string,
  user: User,
  votedUserId: string
) {
  const tableRef = doc(db, "tables", tableId);
  const tableSnap = await getDoc(tableRef);
  if (!tableSnap.exists()) throw new Error("Tavolo inesistente.");
  const tableData = tableSnap.data() as any;

  const currentHandId = tableData.currentHandId;
  if (!currentHandId) throw new Error("Nessuna mano corrente.");

  const handRef = doc(db, "tables", tableId, "hands", currentHandId);
  const handSnap = await getDoc(handRef);
  if (!handSnap.exists()) throw new Error("Mano non trovata.");

  const hand = handSnap.data() as any as HandData;
  if (!hand.votingOpen) throw new Error("Votazione non aperta per questa mano.");

  // Recuperiamo tutti i giocatori attivi al tavolo per sapere quanti devono votare
  const playersRef = collection(db, "tables", tableId, "players");
  const playersSnap = await getDocs(playersRef);
  const players = playersSnap.docs.map((d) => d.data() as any);

  const totalVoters = players.filter((p) => !p.isSittingOut).length || players.length;

  const currentVotes: Record<string, string> = { ...(hand.votes || {}) };
  currentVotes[user.uid] = votedUserId;

  // Conta i voti per ciascun candidato
  const counts: Record<string, number> = {};
  Object.values(currentVotes).forEach((candidateId) => {
    counts[candidateId] = (counts[candidateId] || 0) + 1;
  });

  const votesCount = Object.keys(currentVotes).length;

  let winnerId: string | null = null;

  // Se hanno votato tutti, scegliamo il candidato con più voti
  if (votesCount >= totalVoters) {
    let maxVotes = -1;
    for (const [candidateId, c] of Object.entries(counts)) {
      if (c > maxVotes) {
        maxVotes = c;
        winnerId = candidateId;
      }
    }
  }

  const batch = writeBatch(db);

  // Aggiorna la mano con voti e, se presente, winnerId e chiusura votazione
  const handUpdate: any = {
    votes: currentVotes
  };

  if (winnerId) {
    handUpdate.winnerId = winnerId;
    handUpdate.votingOpen = false;
  }

  batch.update(handRef, handUpdate);

  // Se abbiamo un vincitore, trasferiamo il piatto
  if (winnerId) {
    const winnerPlayerRef = doc(db, "tables", tableId, "players", winnerId);
    const winnerSnap = await getDoc(winnerPlayerRef);
    if (winnerSnap.exists()) {
      const winnerData = winnerSnap.data() as any;
      const newStack = (Number(winnerData.stack) || 0) + (hand.pot || 0);
      batch.update(winnerPlayerRef, { stack: newStack });
    }
  }

  await batch.commit();
}




