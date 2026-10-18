package sh.openagi.mobile.ui.components

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TabBarVisibilityTest {
    @Test
    fun anOpenSupervisorChatGetsTheFullHeight() {
        assertFalse(tabBarVisible(AppTab.SUPERVISOR, supervisorChatOpen = true, keyboardOpen = false))
    }

    @Test
    fun backOnTheSupervisorDashboardShowsTheBar() {
        assertTrue(tabBarVisible(AppTab.SUPERVISOR, supervisorChatOpen = false, keyboardOpen = false))
    }

    @Test
    fun aSupervisorChatLeftOpenDoesNotHideTheBarOnOtherTabs() {
        assertTrue(tabBarVisible(AppTab.TODAY, supervisorChatOpen = true, keyboardOpen = false))
    }

    @Test
    fun theChatTabKeepsTheBar() {
        assertTrue(tabBarVisible(AppTab.CHAT, supervisorChatOpen = false, keyboardOpen = false))
    }

    @Test
    fun theBarIsNeverDrawnAboveTheKeyboard() {
        AppTab.entries.forEach { tab ->
            assertFalse(tabBarVisible(tab, supervisorChatOpen = false, keyboardOpen = true))
        }
    }
}
