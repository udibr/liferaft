//
// Create a custom Raft instance which uses libp2p-webrtc-star to
// communicate back and forth.
//
// merging tcp.js with https://github.com/libp2p/js-libp2p/tree/master/examples/
//
// In a different window go to the root of the project and run signaling server
//    npm i
//    node node_modules/.bin/star-signal
// run several nodes
//    node p2p.js --peer 0 --npeers 3
//    node p2p.js --peer 1 --npeers 3
//    node p2p.js --peer 2 --npeers 3
//
const debug = require('diagnostics')('raft')
  , argv = require('argh').argv
  , LifeRaft = require('../')

const Log = require('../log')
const assert = require("assert")



const wrtc = require('wrtc') // needed when using node
const WStar = require('libp2p-webrtc-star')
// our local signaling server
const webrtcAddrs = [
  '/ip4/0.0.0.0/tcp/9090/wss/p2p-webrtc-star',
// for practical demos and experimentation you can use p2p-webrtc-star signaling server
// instead of running your own local signaling server
// it *should not be used for apps in production*:
// '/dns4/star-signal.cloud.ipfs.team/tcp/443/wss/p2p-webrtc-star'
// '/dns4/wrtc-star.discovery.libp2p.io/tcp/443/wss/p2p-webrtc-star'
// '/dns4/ws-star.discovery.libp2p.io/tcp/443/wss/p2p-webrtc-star'
]

const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const pipe = require('it-pipe')
const lp = require('it-length-prefixed')

const libp2p = require('libp2p')
const TCP = require('libp2p-tcp')

const WS = require('libp2p-websockets')
const mplex = require('libp2p-mplex')
const secio = require('libp2p-secio')
const Boostrap = require('libp2p-bootstrap')

//
// We're going to start with a static list of servers. A minimum cluster size is
// 4 as that only requires majority of 3 servers to have a new leader to be
// assigned. This allows the failure of one single server.
//
// Each node has a libp2p id, privKey and pubKey. The privKey should be of course kept private in the real world.
const peers = require('./peers')


//
// The port command line argument is the index of this Node process.
//
const peer = +argv.peer || 0
const npeers = +argv.npeers || peers.length
assert.ok(peer < npeers, 'peer too big')
const myId = peers[peer].id


function log(txt) {
  console.info(txt)
}

let streams = {}

class TCPRaft extends LifeRaft {
  /**
   * Initialized, start connecting all the things.
   *
   * @param {Object} options Options.
   * @api private
   */
  async initialize (options) {
    const myIdConfig = peers.find(x=>(x.id===this.address))
    const myPeerId = await PeerId.createFromJSON(myIdConfig)

    // Listener libp2p node
    const myPeerInfo = new PeerInfo(myPeerId)

    // Add the signaling server address, along with our PeerId to our multiaddrs list
    // libp2p will automatically attempt to dial to the signaling server so that it can
    // receive inbound connections from other peers
    webrtcAddrs.forEach(webrtcAddr => myPeerInfo.multiaddrs.add(webrtcAddr))

    // Create our libp2p node
    const myNode = new libp2p({
      peerInfo: myPeerInfo,
      modules: {
        transport: [WS, WStar],
        connEncryption: [secio],
        streamMuxer: [mplex],
      },
      config: {
        transport: {
          WebRTCStar: {
            wrtc: wrtc  // needed when using node
          }
        }
      }
    })

    // Listen for new peers
    myNode.on('peer:discovery', (peerInfo) => {
      log(`Found peer ${peerInfo.id.toB58String()}`)
    })

    // Listen for new connections to peers
    myNode.on('peer:connect', async (peerInfo) => {
      const { stream } = await myNode.dialProtocol(peerInfo, '/echo/1.0.0')

      log(`dialed ${peerInfo.id.toB58String()} on protocol: /echo/1.0.0`)
      streams[peerInfo.id.toB58String()] = stream
    })

    // Listen for peers disconnecting
    myNode.on('peer:disconnect', (peerInfo) => {
      let address = peerInfo.id.toB58String()
      log(`Disconnected from ${address}`)
      if (streams && streams[address]) delete streams[address]
    })

    // Handle incoming connections for the protocol by piping from the stream
    // back to itself (an echo)
    let transform = (() => {
      let t = this
      return (source) => {
        return (async function * () { // A generator is async iterable
          // For each chunk of data
          for await (const data of source) {
            // Output the data
            log(`received message: ${data.toString()}`)
            let dataObj = JSON.parse(data.toString());
            debug(t.address +':packet#data', dataObj);
            yield await new Promise((resolve, reject) => {
              t.emit('data', dataObj, data => {
                debug(t.address + ':packet#reply', data)
                resolve(JSON.stringify(data))
              })
            })
          }
        })()
      }
    })()

    await myNode.handle('/echo/1.0.0',
      ({ stream }) => {
      pipe(
          stream.source,
          // Decode length-prefixed data
          lp.decode(),
          // A transform takes a source, and returns a source.
          transform,
          // Encode with length prefix (so receiving side knows how much data is coming)
          lp.encode(),
          stream.sink
        )
     }
    )

    // Start listening
    await myNode.start()


    log('Listener ready, listening on:')
    log(`my libp2p node id is ${myNode.peerInfo.id.toB58String()}`)
    myNode.peerInfo.multiaddrs.forEach((ma) => {
      log(ma.toString())
    })

    this.once('end', function enc() {
      myNode.stop()
    })
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
    debug(this.address +':packet#write', packet);
    try {
      let stream = streams[this.address]
      pipe(
        // Source data
        [JSON.stringify(packet)],
        // Encode with length prefix (so receiving side knows how much data is coming)
        lp.encode(),
        // Write to the stream, and pass its output to the next function
        stream,
        // Decode length-prefixed data
        lp.decode(),
        // Sink function
        async function (source) {
          // For each chunk of data
          for await (const data of source) {
            // Output the data
            log(`received reply: ${data.toString()}`)
            let dataObj = JSON.parse(data.toString())
            // debug(this.address +':packet#callback', packet)
            fn(undefined, dataObj)
          }
        }
      )
    } catch (e) {
      // if (streams && streams[this.address]) delete streams[this.address]
      return fn(e)
    }
  }
}

//
// Now that we have all our variables we can safely start up our server with our
// assigned port number.
//
const raft = new TCPRaft(myId, {
  'election min': 2000,
  'election max': 5000,
  'heartbeat': 1000,
  Log,
  // adapter: require('leveldown'),
  path: './'+myId
})

raft.on('heartbeat timeout', () => {
  debug('heart beat timeout, starting election');
})

raft.on('term change', (to, from) => {
  debug('were now running on term %s -- was %s', to, from);
}).on('leader change', function (to, from) {
  debug('we have a new leader to: %s -- was %s', to, from);
}).on('state change', function (to, from) {
  debug('we have a state to: %s -- was %s', to, from);
})

raft.on('leader', () => {
  log('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@');
  log('I am elected as leader');
  log('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@');
  raft.command({name: 'Leader', address: raft.address});
})

raft.on('candidate', () => {
  log('----------------------------------');
  log('I am starting as candidate');
  log('----------------------------------');
})

raft.on('leader change', (leaderId) => {
  log('----------------------------------');
  log('leader changed to '+leaderId);
  log('----------------------------------');
})

raft.on('commit',  (command) => {
  log(`commit ${command.name} ${command.surname}`)
})
//
// Join in other nodes so they start searching for each other.
//
peers.forEach((nr, idx) => {
  if (idx > npeers) return
  if (!nr || nr.id === myId) return

  raft.join(nr.id)
})
