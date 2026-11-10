<?php

/**
 * @return never
 */
function employeeNotificationsRespondGet(PDO $pdo, int $employeeId): void
{
    $countStmt = $pdo->prepare('SELECT COUNT(*) AS count
        FROM tbl_csdl_notifications
        WHERE notification_employee_id = ?
        AND notification_is_read = 0');
    $countStmt->execute([$employeeId]);
    $unreadCount = (int) $countStmt->fetch(PDO::FETCH_ASSOC)['count'];

    $totalStmt = $pdo->prepare('SELECT COUNT(*) AS count
        FROM tbl_csdl_notifications
        WHERE notification_employee_id = ?');
    $totalStmt->execute([$employeeId]);
    $totalCount = (int) $totalStmt->fetch(PDO::FETCH_ASSOC)['count'];

    $selectSql = 'SELECT
        notification_id,
        notification_title,
        notification_message,
        notification_is_read,
        notification_created_at,
        notification_loan_id
        FROM tbl_csdl_notifications
        WHERE notification_employee_id = ?
        ORDER BY notification_created_at DESC';

    if (isset($_GET['page'])) {
        $page = max(1, (int) ($_GET['page'] ?? 1));
        $perPage = min(50, max(5, (int) ($_GET['perPage'] ?? 20)));
        $offset = ($page - 1) * $perPage;

        $notifStmt = $pdo->prepare($selectSql . ' LIMIT ? OFFSET ?');
        $notifStmt->bindValue(1, $employeeId, PDO::PARAM_INT);
        $notifStmt->bindValue(2, $perPage, PDO::PARAM_INT);
        $notifStmt->bindValue(3, $offset, PDO::PARAM_INT);
        $notifStmt->execute();
        $notifications = $notifStmt->fetchAll(PDO::FETCH_ASSOC);
        $totalPages = $perPage > 0 ? (int) ceil($totalCount / $perPage) : 1;

        echo json_encode([
            'success' => true,
            'unreadCount' => $unreadCount,
            'notifications' => $notifications,
            'pagination' => [
                'page' => $page,
                'perPage' => $perPage,
                'total' => $totalCount,
                'totalPages' => max(1, $totalPages),
            ],
        ]);
        exit;
    }

    $limit = min(50, max(1, (int) ($_GET['limit'] ?? 10)));
    $notifStmt = $pdo->prepare($selectSql . ' LIMIT ?');
    $notifStmt->bindValue(1, $employeeId, PDO::PARAM_INT);
    $notifStmt->bindValue(2, $limit, PDO::PARAM_INT);
    $notifStmt->execute();
    $notifications = $notifStmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        'success' => true,
        'unreadCount' => $unreadCount,
        'notifications' => $notifications,
    ]);
    exit;
}
