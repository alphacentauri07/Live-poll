import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST']
  }
});


const pollSessions = new Map();
const pendingStudents = new Map(); 
let activeSessionId = null; 

function createSession() {
  const id = uuidv4().slice(0, 6);
  pollSessions.set(id, {
    id,
    teacherSocketId: null,
    students: new Map(),
    currentQuestion: null,
    pastQuestions: []
  });
  return pollSessions.get(id);
}

app.get('/health', (_, res) => res.json({ ok: true }));
app.post('/api/polls', (req, res) => {
  const session = createSession();
  res.json({ pollId: session.id });
});


function canAskAnotherQuestion(session) {
  if (!session.currentQuestion) return true;
  const everyoneAnswered = session.currentQuestion.totalAnswers >= session.students.size && session.students.size > 0;
  const finished = session.currentQuestion.status !== 'active';
  return everyoneAnswered || finished;
}

function concludeQuestion(ioNamespace, session, reason = 'ended') {
  if (!session.currentQuestion) return;
  session.currentQuestion.status = 'finished';
  clearTimeout(session.currentQuestion._timerRef);
  const result = {
    questionId: session.currentQuestion.id,
    text: session.currentQuestion.text,
    options: session.currentQuestion.options.map(({ id, text, count }) => ({ id, text, count })),
    totalAnswers: session.currentQuestion.totalAnswers,
    durationSec: session.currentQuestion.durationSec
  };
  session.pastQuestions.unshift({ ...result, finishedAt: Date.now(), reason });
  ioNamespace.to(session.id).emit('questionFinished', result);
  session.currentQuestion = null;
}

function getMostRecentActiveSession() {
  let latest = null;
  for (const p of pollSessions.values()) {
    if (p.teacherSocketId) latest = p;
  }
  return latest;
}

function findSessionByStudentSocket(socketId) {
  for (const p of pollSessions.values()) {
    if (p.students.has(socketId)) return p;
  }
  return null;
}

io.on('connection', (socket) => {
  
  socket.on('teacher:init', ({ pollId }) => {
    let session = pollId && pollSessions.get(pollId);
    if (!session) {
      session = createSession();
    }
    session.teacherSocketId = socket.id;
    activeSessionId = session.id;
    socket.join(session.id);
    socket.emit('teacher:ready', {
      pollId: session.id,
      students: Array.from(session.students.values()),
      currentQuestion: session.currentQuestion ? {
        id: session.currentQuestion.id,
        text: session.currentQuestion.text,
        options: session.currentQuestion.options.map(({ id, text, count }) => ({ id, text, count })),
        askedAt: session.currentQuestion.askedAt,
        durationSec: session.currentQuestion.durationSec,
        totalAnswers: session.currentQuestion.totalAnswers,
        status: session.currentQuestion.status
      } : null,
      pastQuestions: session.pastQuestions
    });

    if (pendingStudents.size > 0) {
      for (const [sid, data] of pendingStudents.entries()) {
        const studentSocket = io.sockets.sockets.get(sid);
        if (!studentSocket) {
          pendingStudents.delete(sid);
          continue;
        }
        const student = { id: sid, name: String(data.name || '').trim().slice(0, 40) };
        session.students.set(sid, student);
        studentSocket.join(session.id);
        // notify student and roster
        io.to(session.id).emit('roster:update', Array.from(session.students.values()));
        studentSocket.emit('student:ready', {
          currentQuestion: session.currentQuestion ? {
            id: session.currentQuestion.id,
            text: session.currentQuestion.text,
            options: session.currentQuestion.options.map(({ id, text, count }) => ({ id, text, count })),
            askedAt: session.currentQuestion.askedAt,
            durationSec: session.currentQuestion.durationSec,
            totalAnswers: session.currentQuestion.totalAnswers,
            status: session.currentQuestion.status
          } : null,
          pastQuestions: session.pastQuestions
        });
        pendingStudents.delete(sid);
      }
    }
  });

  socket.on('student:init', ({ pollId, name }) => {
    let session = null;
    if (pollId && pollSessions.get(pollId)) {
      session = pollSessions.get(pollId);
    } else if (activeSessionId && pollSessions.get(activeSessionId)) {
      session = pollSessions.get(activeSessionId);
    } else {
      session = getMostRecentActiveSession();
    }
    const studentName = String(name || '').trim().slice(0, 40);
    if (!session) {
      // queue student until a teacher initializes a poll
      pendingStudents.set(socket.id, { name: studentName });
      socket.emit('student:waiting');
      return;
    }
    const student = { id: socket.id, name: studentName };
    session.students.set(socket.id, student);
    socket.join(session.id);
    io.to(session.id).emit('roster:update', Array.from(session.students.values()));
    socket.emit('student:ready', {
      currentQuestion: session.currentQuestion ? {
        id: session.currentQuestion.id,
        text: session.currentQuestion.text,
        options: session.currentQuestion.options.map(({ id, text, count }) => ({ id, text, count })),
        askedAt: session.currentQuestion.askedAt,
        durationSec: session.currentQuestion.durationSec,
        totalAnswers: session.currentQuestion.totalAnswers,
        status: session.currentQuestion.status
      } : null,
      pastQuestions: session.pastQuestions
    });
  });

  socket.on('teacher:askQuestion', ({ pollId, text, options, durationSec }) => {
    const session = pollSessions.get(pollId);
    if (!session) return socket.emit('errorMessage', 'Poll not found');
    if (session.teacherSocketId !== socket.id) return socket.emit('errorMessage', 'Not authorized');
    if (!canAskAnotherQuestion(session)) return socket.emit('errorMessage', 'Wait until previous question finishes');

    const questionId = uuidv4();
    const normalizedOptions = (options && options.length ? options : ['A', 'B', 'C', 'D']).map((t) => ({
      id: uuidv4(),
      text: String(t).slice(0, 80),
      count: 0
    }));
    const duration = Number(durationSec) > 0 ? Math.min(Number(durationSec), 300) : 60;
    const question = {
      id: questionId,
      text: String(text || 'Question').slice(0, 140),
      options: normalizedOptions,
      askedAt: Date.now(),
      durationSec: duration,
      totalAnswers: 0,
      status: 'active',
      answeredBy: new Set(),
      _timerRef: null
    };
    session.currentQuestion = question;
    // Start countdown timer
    question._timerRef = setTimeout(() => {
      concludeQuestion(io, session, 'timeout');
    }, duration * 1000);

    io.to(session.id).emit('questionAsked', {
      id: question.id,
      text: question.text,
      options: question.options.map(({ id, text }) => ({ id, text })),
      askedAt: question.askedAt,
      durationSec: question.durationSec
    });
  });

  socket.on('student:submit', ({ pollId, questionId, optionId }) => {
    const session = pollId ? pollSessions.get(pollId) : findSessionByStudentSocket(socket.id);
    if (!session || !session.currentQuestion) return;
    const q = session.currentQuestion;
    if (q.id !== questionId || q.status !== 'active') return;
    if (q.answeredBy.has(socket.id)) return; // only once per student

    const option = q.options.find((o) => o.id === optionId);
    if (!option) return;
    option.count += 1;
    q.totalAnswers += 1;
    q.answeredBy.add(socket.id);

    // Emit incremental results for teacher
    io.to(session.id).emit('results:update', {
      questionId: q.id,
      options: q.options.map(({ id, text, count }) => ({ id, text, count })),
      totalAnswers: q.totalAnswers,
      studentsTotal: session.students.size
    });

    if (q.totalAnswers >= session.students.size && session.students.size > 0) {
      concludeQuestion(io, session, 'all_answered');
    }
  });

  socket.on('teacher:endQuestion', ({ pollId }) => {
    const session = pollSessions.get(pollId);
    if (!session) return;
    if (session.teacherSocketId !== socket.id) return;
    concludeQuestion(io, session, 'teacher_end');
  });

  socket.on('teacher:removeStudent', ({ pollId, studentId }) => {
    const session = pollSessions.get(pollId);
    if (!session) return;
    if (session.teacherSocketId !== socket.id) return;
    if (session.students.has(studentId)) {
      const s = io.sockets.sockets.get(studentId);
     
      // 🔥 Tell the student they were kicked
    if (s) {
      s.emit('student:kicked');
      s.leave(session.id);
      // optional: also close their socket if you really want
      // s.disconnect(true);
    }

      session.students.delete(studentId);
      io.to(session.id).emit('roster:update', Array.from(session.students.values()));
    }
  });

  socket.on('chat:send', ({ pollId, from, message, role }) => {
    const session = pollId ? pollSessions.get(pollId) : findSessionByStudentSocket(socket.id);
    if (!session) return;
    const payload = {
      id: uuidv4(),
      at: Date.now(),
      from: String(from || '').slice(0, 40),
      role: role === 'teacher' ? 'teacher' : 'student',
      message: String(message || '').slice(0, 280)
    };
    io.to(session.id).emit('chat:message', payload);
  });

  socket.on('disconnect', () => {
    // Remove student from any poll
    for (const session of pollSessions.values()) {
      if (session.students.has(socket.id)) {
        session.students.delete(socket.id);
        io.to(session.id).emit('roster:update', Array.from(session.students.values()));
      }
      if (session.teacherSocketId === socket.id) {
        session.teacherSocketId = null;
        if (activeSessionId === session.id) {
          activeSessionId = null;
        }
      }
    }
    if (pendingStudents.has(socket.id)) {
      pendingStudents.delete(socket.id);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

