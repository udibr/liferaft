// merging tcp.js with https://github.com/libp2p/js-libp2p/tree/master/examples/chat
const debug = require('diagnostics')('raft')
  , argv = require('argh').argv
  , LifeRaft = require('../')
  , net = require('net');

// Each node has a libp2p id, privKey and pubKey. The privKey should be of course kept private in the real world.
const peers = require('./peers')

const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const pipe = require('it-pipe')

const Libp2p = require('libp2p')
const TCP = require('libp2p-tcp')
const WS = require('libp2p-websockets')
const mplex = require('libp2p-mplex')
const secio = require('libp2p-secio')

//
// We're going to start with a static list of servers. A minimum cluster size is
// 4 as that only requires majority of 3 servers to have a new leader to be
// assigned. This allows the failure of one single server.
//


//
// The port index of this Node process.
//
const port = peers[+argv.port || 0].id;

async function createDialer(myId) {
  const idDialerConfig = peers.find(x => (x.id === myId))
  const idDialer = await PeerId.createFromJSON(idDialerConfig)

  // Create a new libp2p node on localhost with a randomly chosen port
  const peerDialer = new PeerInfo(idDialer)
  peerDialer.multiaddrs.add('/ip4/0.0.0.0/tcp/0')
  const nodeDialer = new Libp2p({
    peerInfo: peerDialer,
    modules: {
      transport: [
        TCP,
        WS
      ],
      streamMuxer: [mplex],
      connEncryption: [secio]
    }
  })

  // Start the libp2p host
  await nodeDialer.start()

  return nodeDialer
}
const nodeDialerPromise = createDialer(port)

//
// Create a custom Raft instance which uses a plain TCP server and client to
// communicate back and forth.
//
class TCPRaft extends LifeRaft {

  /**
   * Initialized, start connecting all the things.
   *
   * @param {Object} options Options.
   * @api private
   */
  async initialize (options) {
    this.streams = {}
    const listenerIdConfig = peers.find(x=>(x.id===this.address))
    const listenerId = await PeerId.createFromJSON(listenerIdConfig)

    // Listener libp2p node
    const listenerPeerInfo = new PeerInfo(listenerId)
    listenerPeerInfo.multiaddrs.add('/ip4/0.0.0.0/tcp/'+listenerIdConfig.port)
    const listenerNode = new Libp2p({
      peerInfo: listenerPeerInfo,
      modules: {
        transport: [
          TCP,
          WS
        ],
        streamMuxer: [ mplex ],
        connEncryption: [ secio ]
      }
    })

    // Log a message when we receive a connection
    listenerNode.on('peer:connect', (peerInfo) => {
      console.log('received dial to me from:', peerInfo.id.toB58String())
    })

    // Handle incoming connections for the protocol by piping from the stream
    // back to itself (an echo)
    await listenerNode.handle('/echo/1.0.0',
      ({ stream }) => {
        stream.source.then(buff => {
          var data = JSON.parse(buff.toString());

          debug(this.address +':packet#data', data);
          this.emit('data', data, data => {
            debug(this.address +':packet#reply', data);
            stream.sink(JSON.stringify(data));
          });
        })
      }
    )

    // Start listening
    await listenerNode.start()

    console.log('Listener ready, listening on:')
    listenerNode.peerInfo.multiaddrs.forEach((ma) => {
      console.log(ma.toString() + '/p2p/' + listenerId.toB58String())
    })

    this.once('end', function enc() {
      listenerNode.stop();
    });
  }

  /**
   * The message to write.
   *
   * @TODO implement indefinitely sending of packets.
   * @param {Object} packet The packet to write to the connection.
   * @param {Function} fn Completion callback.
   * @api private
   */
  async write (packet, fn) {
    try {
      if (!this.streams) this.streams = {}
      let stream = this.streams[this.address]
      if (!stream) {
        // Dial to the remote peer (the "listener")
        const idListenerConfig = peers.find(x => (x.id === this.address))
        const idListener = await PeerId.createFromJSON(idListenerConfig)
        // Create a PeerInfo with the listening peer's address
        const peerListener = new PeerInfo(idListener)
        peerListener.multiaddrs.add('/ip4/127.0.0.1/tcp/'+idListenerConfig.port)

        // Output this node's address
        // console.log('Dialer ready, listening on:')
        // peerListener.multiaddrs.forEach((ma) => {
        //   console.log(ma.toString() + '/p2p/' + idListener.toB58String())
        // })

        // Dial to the remote peer (the "listener")
        let nodeDialer = await nodeDialerPromise
        const r = await nodeDialer.dialProtocol(peerListener, '/chat/1.0.0')
        console.log('Dialer dialed to listener on protocol: /chat/1.0.0')
        stream = r.stream

        this.streams[this.address] = stream
      }

      await stream.sink(JSON.stringify(packet))

      let buff = await this.streams[this.address].source
      let data = JSON.parse(buff.toString())
      debug(this.address +':packet#callback', packet);
      fn(undefined, data);
    } catch (e) {
      if (this.streams[this.address]) delete this.streams[this.address]
      return fn(e)
    }
  }
}

//
// Now that we have all our variables we can safely start up our server with our
// assigned port number.
//
const raft = new TCPRaft(port, {
  'election min': 2000,
  'election max': 5000,
  'heartbeat': 1000
});

raft.on('heartbeat timeout', () => {
  debug('heart beat timeout, starting election');
});

raft.on('term change', (to, from) => {
  debug('were now running on term %s -- was %s', to, from);
}).on('leader change', function (to, from) {
  debug('we have a new leader to: %s -- was %s', to, from);
}).on('state change', function (to, from) {
  debug('we have a state to: %s -- was %s', to, from);
});

raft.on('leader', () => {
  console.log('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@');
  console.log('I am elected as leader');
  console.log('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@');
});

raft.on('candidate', () => {
  console.log('----------------------------------');
  console.log('I am starting as candidate');
  console.log('----------------------------------');
});

//
// Join in other nodes so they start searching for each other.
//
peers.forEach((nr) => {
  if (!nr || nr.id === port) return;

  raft.join(nr.id);
});
