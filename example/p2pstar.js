// In a different window go to the root of the project and run
//    node node_modules/.bin/star-signal
const wrtc = require('wrtc') // needed when using node
const WStar = require('libp2p-webrtc-star')

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
const Boostrap = require('libp2p-bootstrap')

async function run () {
  // Create our libp2p node
  const libp2p = await Libp2p.create({
    modules: {
      transport: [WS, WStar],
      connEncryption: [secio],
      streamMuxer: [mplex],
      peerDiscovery: [Boostrap]
    },
    config: {
      transport: {
        WebRTCStar: {
          wrtc: wrtc  // needed when using node
        }
      },
      peerDiscovery: {
        bootstrap: {
          enabled: true,
          list: [
            '/dns4/ams-1.bootstrap.libp2p.io/tcp/443/wss/p2p/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd',
            '/dns4/lon-1.bootstrap.libp2p.io/tcp/443/wss/p2p/QmSoLMeWqB7YGVLJN3pNLQpmmEk35v6wYtsMGLzSr5QBU3',
            '/dns4/sfo-3.bootstrap.libp2p.io/tcp/443/wss/p2p/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM',
            '/dns4/sgp-1.bootstrap.libp2p.io/tcp/443/wss/p2p/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu',
            '/dns4/nyc-1.bootstrap.libp2p.io/tcp/443/wss/p2p/QmSoLueR4xBeUbY9WZ9xGUUxunbKWcrNFTDAadQJmocnWm',
            '/dns4/nyc-2.bootstrap.libp2p.io/tcp/443/wss/p2p/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64'
          ]
        }
      }
    }
  })

  function log(txt) {
    console.info(txt)
  }

  // Add the signaling server address, along with our PeerId to our multiaddrs list
  // libp2p will automatically attempt to dial to the signaling server so that it can
  // receive inbound connections from other peers
  const webrtcAddr = '/ip4/0.0.0.0/tcp/9090/wss/p2p-webrtc-star'
  libp2p.peerInfo.multiaddrs.add(webrtcAddr)

  // Listen for new peers
  libp2p.on('peer:discovery', (peerInfo) => {
    log(`Found peer ${peerInfo.id.toB58String()}`)
  })

  // Listen for new connections to peers
  libp2p.on('peer:connect', (peerInfo) => {
    log(`Connected to ${peerInfo.id.toB58String()}`)
  })

  // Listen for peers disconnecting
  libp2p.on('peer:disconnect', (peerInfo) => {
    log(`Disconnected from ${peerInfo.id.toB58String()}`)
  })

  await libp2p.start()
  log(`libp2p id is ${libp2p.peerInfo.id.toB58String()}`)
}

run()
