package sh.openagi.mobile.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import sh.openagi.mobile.ui.theme.OpenAGIType

// The chat screens' one-row top bar: an optional back arrow, the title at a
// normal size, and the connection dot. The full connection line (host and
// status) would cost a second row on every chat, so it sits behind a tap on
// the title or dot instead, in a small dialog. The status bar inset is
// already reserved by the Activity's Scaffold.
@Composable
fun ChatTopBar(title: String, connection: ConnectionState, onBack: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    var showConnection by rememberSaveable { mutableStateOf(false) }
    val (dotColor, dotFilled) = connectionDotStyle(connection)
    val status = connectionCaption(connection)

    Row(
        modifier = modifier
            .fillMaxWidth()
            // At least 52, and taller when a large font scale needs it,
            // so the title is never clipped.
            .heightIn(min = 52.dp)
            .padding(start = if (onBack != null) 4.dp else 16.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack) {
                BackArrowGlyph(tint = MaterialTheme.colorScheme.onBackground, modifier = Modifier.semantics { contentDescription = "Back" })
            }
        }
        Row(
            modifier = Modifier
                .weight(1f, fill = false)
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClickLabel = "Show connection") { showConnection = true }
                .semantics { contentDescription = "$title, $status" }
                .padding(horizontal = 4.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title,
                style = OpenAGIType.chatTitle,
                color = MaterialTheme.colorScheme.onBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            val dot = Modifier.padding(start = 8.dp).size(8.dp).clip(CircleShape)
            Box(if (dotFilled) dot.background(dotColor) else dot.border(1.dp, dotColor, CircleShape))
        }
    }

    if (showConnection) {
        AlertDialog(
            onDismissRequest = { showConnection = false },
            title = { Text("Connection", style = OpenAGIType.section) },
            // The full host on its own line, wrapping rather than cut off,
            // and the status under it: the dialog is where the whole address
            // can finally be read.
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        connectionHost(connection),
                        style = OpenAGIType.dataMono,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val statusDot = Modifier.padding(end = 8.dp).size(6.dp).clip(CircleShape)
                        Box(if (dotFilled) statusDot.background(dotColor) else statusDot.border(1.dp, dotColor, CircleShape))
                        Text(status, style = OpenAGIType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showConnection = false }) { Text("Done") }
            },
        )
    }
}

// A left-pointing arrow drawn like the NavIcons glyphs: no icon library.
// Mirrored in a right-to-left layout so it still points "back".
@Composable
fun BackArrowGlyph(tint: Color, modifier: Modifier = Modifier) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    Canvas(modifier = modifier.size(22.dp)) {
        val stroke = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun x(f: Float) = size.width * (if (rtl) 1f - f else f)
        drawLine(tint, Offset(x(0.18f), size.height * 0.5f), Offset(x(0.84f), size.height * 0.5f), strokeWidth = stroke.width, cap = StrokeCap.Round)
        val head = Path().apply {
            moveTo(x(0.46f), size.height * 0.2f)
            lineTo(x(0.16f), size.height * 0.5f)
            lineTo(x(0.46f), size.height * 0.8f)
        }
        drawPath(head, color = tint, style = stroke)
    }
}

// An upward arrow for the composer's send button.
@Composable
fun SendArrowGlyph(tint: Color, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier.size(18.dp)) {
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawLine(tint, Offset(size.width * 0.5f, size.height * 0.86f), Offset(size.width * 0.5f, size.height * 0.16f), strokeWidth = stroke.width, cap = StrokeCap.Round)
        val head = Path().apply {
            moveTo(size.width * 0.18f, size.height * 0.46f)
            lineTo(size.width * 0.5f, size.height * 0.14f)
            lineTo(size.width * 0.82f, size.height * 0.46f)
        }
        drawPath(head, color = tint, style = stroke)
    }
}

// A downward arrow for the chat's "Jump to latest" button.
@Composable
fun DownArrowGlyph(tint: Color, modifier: Modifier = Modifier) {
    SendArrowGlyph(tint = tint, modifier = modifier.rotate(180f))
}
