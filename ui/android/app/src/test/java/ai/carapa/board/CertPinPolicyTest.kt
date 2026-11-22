package ai.carapa.board

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CertPinPolicyTest {
    private val leaf = "pinned certificate".toByteArray()
    private val pin = ServerPin("192.168.1.10", 3000, CertPinPolicy.sha256Hex(leaf))

    @Test
    fun allowsMatchingHostPortAndCertificate() {
        assertTrue(CertPinPolicy.allows("192.168.1.10", 3000, leaf, listOf(pin)))
        assertTrue(CertPinPolicy.allows("192.168.1.10", 3000, leaf, listOf(ServerPin("other", 443, "0".repeat(64)), pin)))
    }

    @Test
    fun refusesWrongCertificateHostPortOrNoPins() {
        assertFalse(CertPinPolicy.allows("192.168.1.10", 3000, "other certificate".toByteArray(), listOf(pin)))
        assertFalse(CertPinPolicy.allows("192.168.1.11", 3000, leaf, listOf(pin)))
        assertFalse(CertPinPolicy.allows("192.168.1.10", 443, leaf, listOf(pin)))
        assertFalse(CertPinPolicy.allows("192.168.1.10", 3000, leaf, emptyList()))
    }

    @Test
    fun parsesOriginsWithDefaultPortAndRejectsOthers() {
        val sha = CertPinPolicy.sha256Hex(leaf).uppercase()
        assertEquals(ServerPin("board.example", 443, sha.lowercase()), CertPinPolicy.parsePin("https://Board.Example", sha))
        assertEquals(ServerPin("::1", 3000, sha.lowercase()), CertPinPolicy.parsePin("https://[::1]:3000", sha))
        assertNull(CertPinPolicy.parsePin("http://board.example", sha))
        assertNull(CertPinPolicy.parsePin("https://board.example/path", sha))
        assertNull(CertPinPolicy.parsePin("https://board.example", "abc"))
    }
}
