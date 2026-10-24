"""Run a headless native-dependency check before the normal frozen entry point."""

import sys

if sys.argv[1:] == ['--self-test']:
    import asyncio
    import ssl

    import aiortc
    import av
    import cryptography
    from aiortc import RTCCertificate, RTCPeerConnection
    from cryptography.hazmat.backends.openssl.backend import backend

    async def check_peer_connection():
        # Exercise certificate generation and DTLS setup, beyond import checks.
        certificate = RTCCertificate.generateCertificate()
        assert certificate.getFingerprints(), 'No certificate fingerprints'
        peer = RTCPeerConnection()
        try:
            peer.createDataChannel('packaging-self-test')
            await peer.createOffer()
        finally:
            await peer.close()

    asyncio.run(check_peer_connection())
    print('Python OpenSSL:', ssl.OPENSSL_VERSION, flush=True)
    print('cryptography:', cryptography.__version__, backend.openssl_version_text(), flush=True)
    print('aiortc:', aiortc.__version__, 'PyAV:', av.__version__, flush=True)
    print('ClipCascade packaged dependency self-test passed', flush=True)
    sys.exit(0)
